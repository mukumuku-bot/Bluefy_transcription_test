const elements = {
  micStatus: document.querySelector("#micStatus"),
  nativeStatus: document.querySelector("#nativeStatus"),
  aiStatus: document.querySelector("#aiStatus"),
  checkButton: document.querySelector("#checkButton"),
  recordButton: document.querySelector("#recordButton"),
  playButton: document.querySelector("#playButton"),
  nativeButton: document.querySelector("#nativeButton"),
  nativeStopButton: document.querySelector("#nativeStopButton"),
  aiButton: document.querySelector("#aiButton"),
  modelSelect: document.querySelector("#modelSelect"),
  nativeText: document.querySelector("#nativeText"),
  aiText: document.querySelector("#aiText"),
  audioPlayer: document.querySelector("#audioPlayer"),
  levelBar: document.querySelector("#levelBar"),
  log: document.querySelector("#log"),
};

const state = {
  stream: null,
  audioContext: null,
  analyser: null,
  levelData: null,
  levelRafId: null,
  recorder: null,
  chunks: [],
  recordedBlob: null,
  recognition: null,
  transcribers: new Map(),
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const RECORDING_MS = 8000;
const AI_SAMPLE_RATE = 16000;

elements.checkButton.addEventListener("click", checkFeatures);
elements.recordButton.addEventListener("click", recordSample);
elements.playButton.addEventListener("click", playRecording);
elements.nativeButton.addEventListener("click", startNativeTranscription);
elements.nativeStopButton.addEventListener("click", stopNativeTranscription);
elements.aiButton.addEventListener("click", transcribeWithFreeAi);

renderInitialState();

function renderInitialState() {
  setStatus(elements.micStatus, navigator.mediaDevices?.getUserMedia ? "確認可能" : "非対応");
  setStatus(elements.nativeStatus, SpeechRecognition ? "APIあり" : "APIなし");
  setStatus(elements.aiStatus, "未読み込み");
  log(`UserAgent: ${navigator.userAgent}`);
}

async function checkFeatures() {
  log("機能確認を開始");
  try {
    await ensureMic();
    setStatus(elements.micStatus, "使用できます");
    elements.aiButton.disabled = !state.recordedBlob;
    log("マイク入力: OK");
  } catch (error) {
    setStatus(elements.micStatus, `失敗: ${error.name || "error"}`);
    log(`マイク入力: NG ${error.message || error}`);
  }

  if (SpeechRecognition) {
    setStatus(elements.nativeStatus, "APIあり");
    log("標準文字起こしAPI: あり");
  } else {
    setStatus(elements.nativeStatus, "APIなし");
    log("標準文字起こしAPI: なし");
  }

  setStatus(elements.aiStatus, "録音後に試せます");
}

async function ensureMic() {
  if (state.stream?.getAudioTracks().some((track) => track.readyState === "live")) {
    return state.stream;
  }

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  startLevelMeter(state.stream);
  return state.stream;
}

function startLevelMeter(stream) {
  if (state.analyser) return;

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioContext();
  const source = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 1024;
  state.levelData = new Uint8Array(state.analyser.fftSize);
  source.connect(state.analyser);
  updateLevel();
}

function updateLevel() {
  if (!state.analyser || !state.levelData) return;
  state.analyser.getByteTimeDomainData(state.levelData);

  let sum = 0;
  for (const value of state.levelData) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }

  const rms = Math.sqrt(sum / state.levelData.length);
  const percent = Math.min(100, Math.round(rms * 240));
  elements.levelBar.style.width = `${percent}%`;
  state.levelRafId = requestAnimationFrame(updateLevel);
}

async function recordSample() {
  try {
    const stream = await ensureMic();
    state.chunks = [];
    state.recordedBlob = null;
    elements.recordButton.disabled = true;
    elements.playButton.disabled = true;
    elements.aiButton.disabled = true;
    log("8秒録音を開始。犬の名前や「おいで」をはっきり話してください");

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    state.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    state.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) state.chunks.push(event.data);
    });

    state.recorder.addEventListener("stop", () => {
      state.recordedBlob = new Blob(state.chunks, { type: state.recorder.mimeType || "audio/webm" });
      elements.audioPlayer.src = URL.createObjectURL(state.recordedBlob);
      elements.audioPlayer.hidden = false;
      elements.playButton.disabled = false;
      elements.aiButton.disabled = false;
      elements.recordButton.disabled = false;
      setStatus(elements.micStatus, "録音できました");
      log(`録音完了: ${Math.round(state.recordedBlob.size / 1024)} KB`);
    });

    state.recorder.start();
    window.setTimeout(() => {
      if (state.recorder?.state === "recording") state.recorder.stop();
    }, RECORDING_MS);
  } catch (error) {
    elements.recordButton.disabled = false;
    setStatus(elements.micStatus, `録音失敗: ${error.name || "error"}`);
    log(`録音失敗: ${error.message || error}`);
  }
}

function playRecording() {
  if (!state.recordedBlob) return;
  elements.audioPlayer.hidden = false;
  elements.audioPlayer.play().catch((error) => log(`再生失敗: ${error.message || error}`));
}

function startNativeTranscription() {
  if (!SpeechRecognition) {
    setStatus(elements.nativeStatus, "APIなし");
    log("標準文字起こしAPIがありません");
    return;
  }

  stopNativeTranscription();
  state.recognition = new SpeechRecognition();
  state.recognition.lang = "ja-JP";
  state.recognition.continuous = true;
  state.recognition.interimResults = true;

  state.recognition.addEventListener("start", () => {
    setStatus(elements.nativeStatus, "聞き取り中");
    elements.nativeButton.disabled = true;
    elements.nativeStopButton.disabled = false;
    log("標準文字起こし開始");
  });

  state.recognition.addEventListener("result", (event) => {
    let text = "";
    for (let index = 0; index < event.results.length; index += 1) {
      text += event.results[index][0]?.transcript || "";
    }
    elements.nativeText.value = text.trim();
  });

  state.recognition.addEventListener("error", (event) => {
    setStatus(elements.nativeStatus, `失敗: ${event.error}`);
    log(`標準文字起こしエラー: ${event.error}`);
  });

  state.recognition.addEventListener("end", () => {
    elements.nativeButton.disabled = false;
    elements.nativeStopButton.disabled = true;
    log("標準文字起こし終了");
  });

  try {
    state.recognition.start();
  } catch (error) {
    setStatus(elements.nativeStatus, "開始失敗");
    log(`標準文字起こし開始失敗: ${error.message || error}`);
  }
}

function stopNativeTranscription() {
  if (state.recognition) {
    state.recognition.stop();
    state.recognition = null;
  }
}

async function transcribeWithFreeAi() {
  if (!state.recordedBlob) {
    log("先に8秒録音してください");
    return;
  }

  elements.aiButton.disabled = true;
  const modelId = elements.modelSelect.value;
  setStatus(elements.aiStatus, "読み込み中");
  elements.aiText.value = "";

  try {
    const transcriber = await getTranscriber(modelId);

    setStatus(elements.aiStatus, "解析中");
    const audio = await blobToMono16k(state.recordedBlob);
    log(`AI解析開始: ${modelId}, ${Math.round(audio.data.length / audio.sampleRate)}秒, 音量 ${audio.peakText}`);

    const result = await transcriber(audio.data, {
      sampling_rate: audio.sampleRate,
      language: "ja",
      task: "transcribe",
      return_timestamps: false,
      chunk_length_s: 8,
      stride_length_s: 1,
    });

    const text = typeof result === "string" ? result : result.text || "";
    elements.aiText.value = text.trim() || "認識結果なし";
    setStatus(elements.aiStatus, "完了");
    log(`AI解析完了: ${elements.aiText.value}`);
  } catch (error) {
    setStatus(elements.aiStatus, "失敗");
    log(`AI解析失敗: ${error.message || error}`);
  } finally {
    elements.aiButton.disabled = false;
  }
}

async function getTranscriber(modelId) {
  if (state.transcribers.has(modelId)) return state.transcribers.get(modelId);

  log(`無料AIモデルを読み込み中: ${modelId}`);
  const transformers = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
  transformers.env.allowLocalModels = false;
  const transcriber = await transformers.pipeline("automatic-speech-recognition", modelId);
  state.transcribers.set(modelId, transcriber);
  log(`無料AIモデル読み込み完了: ${modelId}`);
  return transcriber;
}

async function blobToMono16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContext();
  const decoded = await context.decodeAudioData(arrayBuffer);
  const mono = mixToMono(decoded);
  const trimmed = trimSilence(mono, decoded.sampleRate);
  const normalized = normalizeAudio(trimmed);
  const resampled = resampleLinear(normalized.data, decoded.sampleRate, AI_SAMPLE_RATE);
  await context.close?.();
  return {
    data: resampled,
    sampleRate: AI_SAMPLE_RATE,
    peakText: `${Math.round(normalized.peak * 100)}%`,
  };
}

function mixToMono(decoded) {
  const output = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const input = decoded.getChannelData(channel);
    for (let index = 0; index < input.length; index += 1) {
      output[index] += input[index] / decoded.numberOfChannels;
    }
  }
  return output;
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const weight = position - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }

  return output;
}

function trimSilence(input, sampleRate) {
  const threshold = 0.012;
  const padding = Math.round(sampleRate * 0.25);
  let start = 0;
  let end = input.length - 1;

  while (start < input.length && Math.abs(input[start]) < threshold) start += 1;
  while (end > start && Math.abs(input[end]) < threshold) end -= 1;

  if (start >= end) return input;

  const paddedStart = Math.max(0, start - padding);
  const paddedEnd = Math.min(input.length, end + padding);
  return input.slice(paddedStart, paddedEnd);
}

function normalizeAudio(input) {
  let peak = 0;
  for (const sample of input) {
    peak = Math.max(peak, Math.abs(sample));
  }

  if (peak < 0.001) {
    return { data: input, peak };
  }

  const targetPeak = 0.85;
  const gain = Math.min(12, targetPeak / peak);
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = Math.max(-1, Math.min(1, input[index] * gain));
  }

  return { data: output, peak };
}

function setStatus(element, text) {
  element.textContent = text;
}

function log(message) {
  const time = new Date().toLocaleTimeString("ja-JP");
  elements.log.textContent = `[${time}] ${message}\n${elements.log.textContent}`;
}
