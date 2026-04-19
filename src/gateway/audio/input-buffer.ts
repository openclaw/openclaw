/**
 * Real-time PCM audio input buffer — Phase A.2 of streaming multimodal.
 *
 * Buffers PCM16 audio chunks streamed from a client (microphone) before
 * they are committed to the LLM provider. Tracks duration, performs
 * silence-based end-of-speech detection (VAD), and bounds total memory
 * to a configurable wall-clock window (default: 30 seconds).
 *
 * The buffer is intentionally provider-agnostic. Format conversion
 * (e.g. 16 kHz → provider rate) happens upstream in the provider adapter.
 *
 * See: ../multiplex-frame.ts for the wire transport,
 *      ../../../.orchestration/streaming-multimodal-prep/ARCHITECTURE.md §3.2.2
 */

/** Audio format descriptor for PCM streams. */
export interface AudioFormat {
  /** Codec — only "pcm16" is supported in Phase A. */
  readonly type: "pcm16";
  /** Sample rate (Hz). */
  readonly sampleRate: number;
  /** Channel count. Phase A only supports mono (1). */
  readonly channels: 1;
}

/** Default 16 kHz mono PCM16 — matches OpenAI Realtime input format. */
export const DEFAULT_INPUT_FORMAT: AudioFormat = Object.freeze({
  type: "pcm16",
  sampleRate: 16000,
  channels: 1,
});

/** Configuration for the input buffer. */
export interface RealtimeInputBufferOptions {
  /** PCM format. Defaults to 16 kHz mono PCM16. */
  format?: AudioFormat;
  /** Max buffered duration in milliseconds (default 30 000). */
  maxBufferedMs?: number;
  /**
   * Silence detection: amplitude (0..32767) below which a sample is
   * considered silence. Defaults to ~1% of full scale (300).
   */
  vadSilenceThreshold?: number;
  /**
   * Continuous silence duration (ms) that triggers `onSpeechStopped`
   * after speech has previously started. Default 600.
   */
  vadSilenceDurationMs?: number;
  /**
   * Continuous non-silence duration (ms) required to trigger
   * `onSpeechStarted`. Default 100.
   */
  vadSpeechDurationMs?: number;
  /** Optional callback when speech onset detected. */
  onSpeechStarted?: () => void;
  /** Optional callback when speech end detected. */
  onSpeechStopped?: () => void;
  /** Optional clock injector (test seam). */
  now?: () => number;
}

/** Result of a successful commit. */
export interface CommitResult {
  /** Concatenated PCM payload (mono PCM16 little-endian). */
  audio: Buffer;
  /** Total audio duration in milliseconds. */
  durationMs: number;
  /** Sample rate of the committed audio. */
  sampleRate: number;
}

/** Internal speech-detection state. */
type VadState = "silent" | "speaking";

const PCM16_BYTES_PER_SAMPLE = 2;

/**
 * Compute average absolute amplitude of a PCM16 LE buffer.
 * Returns 0 for empty / odd-length buffers.
 */
export function pcm16PeakAmplitude(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / PCM16_BYTES_PER_SAMPLE);
  if (samples === 0) return 0;
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const s = chunk.readInt16LE(i * PCM16_BYTES_PER_SAMPLE);
    const abs = s < 0 ? -s : s;
    if (abs > peak) peak = abs;
  }
  return peak;
}

/** Convert a PCM16 byte length at `sampleRate` Hz into milliseconds. */
export function pcm16BytesToMs(bytes: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  const samples = Math.floor(bytes / PCM16_BYTES_PER_SAMPLE);
  return (samples * 1000) / sampleRate;
}

/**
 * RealtimeInputBuffer — append PCM chunks, optionally drive VAD callbacks,
 * commit() to flush a copy of the buffered audio for downstream send.
 *
 * Not thread-safe; intended to be owned by a single session manager.
 */
export class RealtimeInputBuffer {
  readonly format: AudioFormat;
  readonly maxBufferedMs: number;
  readonly vadSilenceThreshold: number;
  readonly vadSilenceDurationMs: number;
  readonly vadSpeechDurationMs: number;

  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private readonly onSpeechStarted?: () => void;
  private readonly onSpeechStopped?: () => void;
  private readonly clock: () => number;

  private vadState: VadState = "silent";
  private streakStartedAt: number | null = null;

  constructor(options: RealtimeInputBufferOptions = {}) {
    this.format = options.format ?? DEFAULT_INPUT_FORMAT;
    if (this.format.type !== "pcm16" || this.format.channels !== 1) {
      throw new Error(
        `[RealtimeInputBuffer] only mono pcm16 supported in Phase A (got ${this.format.type}, ${this.format.channels}ch)`,
      );
    }
    if (this.format.sampleRate <= 0) {
      throw new Error(`[RealtimeInputBuffer] sampleRate must be positive (got ${this.format.sampleRate})`);
    }
    this.maxBufferedMs = options.maxBufferedMs ?? 30_000;
    this.vadSilenceThreshold = options.vadSilenceThreshold ?? 300;
    this.vadSilenceDurationMs = options.vadSilenceDurationMs ?? 600;
    this.vadSpeechDurationMs = options.vadSpeechDurationMs ?? 100;
    this.onSpeechStarted = options.onSpeechStarted;
    this.onSpeechStopped = options.onSpeechStopped;
    this.clock = options.now ?? (() => Date.now());
  }

  /** Append a PCM16 LE chunk. Drops oldest data if `maxBufferedMs` exceeded. */
  append(chunk: Buffer | Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("[RealtimeInputBuffer.append] chunk must be a Buffer or Uint8Array");
    }
    if (chunk.length === 0) return;
    if (chunk.length % PCM16_BYTES_PER_SAMPLE !== 0) {
      throw new Error("[RealtimeInputBuffer.append] PCM16 chunks must have even byte length");
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.chunks.push(buf);
    this.bufferedBytes += buf.length;
    this.evictOverflow();
    this.tickVad(buf);
  }

  /** Returns currently buffered duration in milliseconds. */
  getBufferedDurationMs(): number {
    return pcm16BytesToMs(this.bufferedBytes, this.format.sampleRate);
  }

  /** Returns total bytes currently held. */
  getBufferedBytes(): number {
    return this.bufferedBytes;
  }

  /** True if VAD considers user currently speaking. */
  isSpeaking(): boolean {
    return this.vadState === "speaking";
  }

  /**
   * Commit (flush) the buffer: returns concatenated audio for handing to
   * the LLM provider, then clears local state. VAD state resets to silent.
   */
  commit(): CommitResult {
    const audio =
      this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.bufferedBytes);
    const durationMs = pcm16BytesToMs(audio.length, this.format.sampleRate);
    this.clearInternal();
    return {
      audio: Buffer.from(audio), // detach from internal storage
      durationMs,
      sampleRate: this.format.sampleRate,
    };
  }

  /** Discard buffered audio without emitting it. */
  clear(): void {
    this.clearInternal();
  }

  // --- internals ----------------------------------------------------------

  private clearInternal(): void {
    this.chunks.length = 0;
    this.bufferedBytes = 0;
    if (this.vadState === "speaking") {
      this.vadState = "silent";
      // No callback fire here: explicit clear shouldn't surface a speech-end event.
    }
    this.streakStartedAt = null;
  }

  private evictOverflow(): void {
    const maxBytes = Math.ceil((this.maxBufferedMs * this.format.sampleRate) / 1000) * PCM16_BYTES_PER_SAMPLE;
    while (this.bufferedBytes > maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const overflow = this.bufferedBytes - maxBytes;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.bufferedBytes -= head.length;
      } else {
        // Trim head in place.
        this.chunks[0] = head.subarray(overflow);
        this.bufferedBytes -= overflow;
      }
    }
  }

  private tickVad(chunk: Buffer): void {
    if (!this.onSpeechStarted && !this.onSpeechStopped) return;
    const peak = pcm16PeakAmplitude(chunk);
    const isSilent = peak < this.vadSilenceThreshold;
    const now = this.clock();

    if (this.vadState === "silent") {
      if (isSilent) {
        this.streakStartedAt = null;
        return;
      }
      if (this.streakStartedAt == null) this.streakStartedAt = now;
      if (now - this.streakStartedAt >= this.vadSpeechDurationMs) {
        this.vadState = "speaking";
        this.streakStartedAt = null;
        this.onSpeechStarted?.();
      }
      return;
    }
    // vadState === "speaking"
    if (!isSilent) {
      this.streakStartedAt = null;
      return;
    }
    if (this.streakStartedAt == null) this.streakStartedAt = now;
    if (now - this.streakStartedAt >= this.vadSilenceDurationMs) {
      this.vadState = "silent";
      this.streakStartedAt = null;
      this.onSpeechStopped?.();
    }
  }
}
