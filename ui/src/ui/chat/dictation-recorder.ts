export type DictationPhase = "idle" | "requesting" | "recording" | "transcribing" | "error";

export type DictationSnapshot = {
  phase: DictationPhase;
  elapsedMs: number;
  levels: number[];
  error: string | null;
};

export type DictationRecorderOptions = {
  onChange: (snapshot: DictationSnapshot) => void;
  onMaxDuration?: () => void;
  maxDurationMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_DURATION_MS = 120_000;
const LEVEL_COUNT = 36;

export function createIdleDictationSnapshot(): DictationSnapshot {
  return { phase: "idle", elapsedMs: 0, levels: Array(LEVEL_COUNT).fill(0.08), error: null };
}

export function insertDictation(
  draft: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number,
): string {
  const start = Math.max(0, Math.min(draft.length, selectionStart));
  const end = Math.max(start, Math.min(draft.length, selectionEnd));
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const text = transcript.trim();
  const prefix = before && !/\s$/.test(before) && text && !/^\s/.test(text) ? " " : "";
  const suffix = after && !/^\s/.test(after) && text && !/\s$/.test(text) ? " " : "";
  return `${before}${prefix}${text}${suffix}${after}`;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone access was denied. Allow microphone access in your browser or system settings, then try again.";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "No microphone was found. Connect or enable an input device, then try again.";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "The microphone is busy or unavailable. Close other audio apps and try again.";
    }
  }
  return error instanceof Error ? error.message : "Unable to start dictation.";
}

function preferredMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

/** Captures one in-memory voice clip and exposes compact UI snapshots. */
export class DictationRecorder {
  private snapshot = createIdleDictationSnapshot();
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private maxTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private audioContext: AudioContext | null = null;
  private analyserFrame: number | null = null;
  private resolveStop: ((blob: Blob | null) => void) | null = null;
  private resolvePermissionConfirm: ((blob: Blob | null) => void) | null = null;
  private captureRequestId = 0;

  constructor(private readonly options: DictationRecorderOptions) {}

  get state(): DictationSnapshot {
    return this.snapshot;
  }

  async start(): Promise<void> {
    if (this.snapshot.phase !== "idle" && this.snapshot.phase !== "error") {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      this.update({
        ...createIdleDictationSnapshot(),
        phase: "error",
        error: "Dictation is not supported by this browser.",
      });
      return;
    }
    const requestId = ++this.captureRequestId;
    this.update({ ...createIdleDictationSnapshot(), phase: "requesting" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (requestId !== this.captureRequestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.chunks = [];
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (this.recorder === recorder && event.data.size > 0) {
          this.chunks.push(event.data);
        }
      });
      this.startedAt = (this.options.now ?? Date.now)();
      this.recorder.start(250);
      this.startMeter(stream);
      this.timer = globalThis.setInterval(() => this.tick(), 100);
      this.maxTimer = globalThis.setTimeout(() => {
        if (this.options.onMaxDuration) {
          this.options.onMaxDuration();
        } else {
          void this.confirm();
        }
      }, this.options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
      this.update({ phase: "recording", elapsedMs: 0, levels: this.snapshot.levels, error: null });
      if (this.resolvePermissionConfirm) {
        const resolve = this.resolvePermissionConfirm;
        this.resolvePermissionConfirm = null;
        void this.confirm().then(resolve);
      }
    } catch (error) {
      this.releaseCapture();
      this.update({
        ...createIdleDictationSnapshot(),
        phase: "error",
        error: microphoneError(error),
      });
      this.resolvePermissionConfirm?.(null);
      this.resolvePermissionConfirm = null;
    }
  }

  async confirm(): Promise<Blob | null> {
    if (this.snapshot.phase === "requesting") {
      return await new Promise((resolve) => {
        this.resolvePermissionConfirm = resolve;
      });
    }
    if (this.snapshot.phase !== "recording" || !this.recorder) {
      return null;
    }
    this.update({ ...this.snapshot, phase: "transcribing", error: null });
    const recorder = this.recorder;
    const stopped = new Promise<Blob | null>((resolve) => {
      this.resolveStop = resolve;
    });
    recorder.addEventListener(
      "stop",
      () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        this.releaseCapture();
        this.resolveStop?.(blob.size > 0 ? blob : null);
        this.resolveStop = null;
      },
      { once: true },
    );
    recorder.stop();
    return await stopped;
  }

  cancel(): void {
    this.captureRequestId += 1;
    this.resolvePermissionConfirm?.(null);
    this.resolvePermissionConfirm = null;
    if (this.recorder?.state !== "inactive") {
      this.resolveStop = null;
      this.recorder?.stop();
    }
    this.releaseCapture();
    this.update(createIdleDictationSnapshot());
  }

  fail(message: string): void {
    this.captureRequestId += 1;
    this.resolvePermissionConfirm?.(null);
    this.resolvePermissionConfirm = null;
    this.releaseCapture();
    this.update({ ...createIdleDictationSnapshot(), phase: "error", error: message });
  }

  reset(): void {
    this.captureRequestId += 1;
    this.resolvePermissionConfirm?.(null);
    this.resolvePermissionConfirm = null;
    this.releaseCapture();
    this.update(createIdleDictationSnapshot());
  }

  private tick(): void {
    if (this.snapshot.phase !== "recording") {
      return;
    }
    this.update({
      ...this.snapshot,
      elapsedMs: Math.max(0, (this.options.now ?? Date.now)() - this.startedAt),
    });
  }

  private startMeter(stream: MediaStream): void {
    if (typeof AudioContext === "undefined") {
      return;
    }
    this.audioContext = new AudioContext();
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    this.audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      if (this.snapshot.phase !== "recording" && this.snapshot.phase !== "requesting") {
        return;
      }
      analyser.getByteFrequencyData(samples);
      const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length / 255;
      const next = [...this.snapshot.levels.slice(1), Math.max(0.08, Math.min(1, average * 2.5))];
      this.update({ ...this.snapshot, levels: next });
      this.analyserFrame = requestAnimationFrame(draw);
    };
    this.analyserFrame = requestAnimationFrame(draw);
  }

  private releaseCapture(): void {
    if (this.timer !== null) {
      globalThis.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.maxTimer !== null) {
      globalThis.clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    if (this.analyserFrame !== null) {
      cancelAnimationFrame(this.analyserFrame);
      this.analyserFrame = null;
    }
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }

  private update(snapshot: DictationSnapshot): void {
    this.snapshot = snapshot;
    this.options.onChange(snapshot);
  }
}
