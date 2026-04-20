/**
 * Audio output stream handler — Phase B.3.
 *
 * Bridges the {@link RealtimeOutputBuffer} primitive from Phase A.2 to
 * the multiplex transport (streamId AUDIO_OUTPUT). The realtime
 * provider adapter calls {@link AudioOutputStream.pushAudio} as deltas
 * arrive; this handler enqueues them, encodes a multiplex frame, and
 * delivers it via the {@link AudioOutputStreamOptions.send} callback.
 *
 * Supports barge-in via {@link AudioOutputStream.truncateAt}, which
 * truncates the underlying buffer and emits an EOM frame so the client
 * can immediately stop playback at the truncated position.
 */
import {
  RealtimeOutputBuffer,
  type OutputAudioChunk,
  type RealtimeOutputBufferOptions,
  type TruncateResult,
} from "./output-buffer.js";
import {
  encodeMultiplexFrame,
  MULTIPLEX_FLAG_EOM,
  MULTIPLEX_STREAM,
} from "../multiplex-frame.js";

/** Send callback signature — receives an encoded multiplex frame. */
export type AudioOutputSend = (frame: Buffer) => void;

export interface AudioOutputStreamOptions extends RealtimeOutputBufferOptions {
  /** Required: how to deliver an encoded multiplex frame to the client. */
  send: AudioOutputSend;
  /**
   * Called when {@link AudioOutputStream.truncateAt} runs, after the
   * underlying buffer has been truncated and the EOM frame sent.
   */
  onTruncate?: (result: TruncateResult) => void;
  /**
   * Called when an audio chunk fails to encode/send (e.g. payload too
   * large). Defaults to silently dropping the chunk.
   */
  onSendError?: (error: Error, chunk: OutputAudioChunk) => void;
}

/**
 * Per-session AudioOutput stream handler. Owns one
 * {@link RealtimeOutputBuffer}.
 */
export class AudioOutputStream {
  /** Stream id this handler emits on. */
  static readonly STREAM_ID = MULTIPLEX_STREAM.AUDIO_OUTPUT;

  readonly buffer: RealtimeOutputBuffer;
  private readonly send: AudioOutputSend;
  private readonly onTruncate?: (result: TruncateResult) => void;
  private readonly onSendError?: (error: Error, chunk: OutputAudioChunk) => void;
  private framesSent = 0;
  private bytesSent = 0;
  private chunksEnqueued = 0;
  private truncations = 0;
  private sendErrors = 0;

  constructor(options: AudioOutputStreamOptions) {
    if (typeof options.send !== "function") {
      throw new TypeError("AudioOutputStream requires a send callback");
    }
    const { send, onTruncate, onSendError, ...bufferOptions } = options;
    this.buffer = new RealtimeOutputBuffer(bufferOptions);
    this.send = send;
    this.onTruncate = onTruncate;
    this.onSendError = onSendError;
  }

  /** Telemetry snapshot. */
  get stats(): {
    framesSent: number;
    bytesSent: number;
    chunksEnqueued: number;
    truncations: number;
    sendErrors: number;
    queueLength: number;
    totalEnqueuedMs: number;
    playbackPositionMs: number;
  } {
    return {
      framesSent: this.framesSent,
      bytesSent: this.bytesSent,
      chunksEnqueued: this.chunksEnqueued,
      truncations: this.truncations,
      sendErrors: this.sendErrors,
      queueLength: this.buffer.getQueueLength(),
      totalEnqueuedMs: this.buffer.getTotalEnqueuedMs(),
      playbackPositionMs: this.buffer.getPlaybackPosition(),
    };
  }

  /**
   * Enqueue an audio chunk and immediately ship it as a multiplex frame.
   *
   * @param payload Raw audio bytes (PCM16 or whatever the negotiated codec is).
   * @param durationMs Playback duration of this chunk.
   * @param options Optional flags (e.g. mark EOM at end of response turn).
   */
  pushAudio(
    payload: Buffer | Uint8Array,
    durationMs: number,
    options?: { eom?: boolean; flags?: number },
  ): OutputAudioChunk | null {
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError("AudioOutputStream.pushAudio payload must be Buffer/Uint8Array");
    }
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);

    let chunk: OutputAudioChunk;
    try {
      chunk = this.buffer.enqueueChunk(buf, durationMs);
      this.chunksEnqueued++;
    } catch (err) {
      this.sendErrors++;
      this.onSendError?.(
        err instanceof Error ? err : new Error(String(err)),
        { payload: buf, durationMs, startMs: 0, endMs: 0 },
      );
      return null;
    }

    let flags = options?.flags ?? 0;
    if (options?.eom) {
      flags |= MULTIPLEX_FLAG_EOM;
    }

    try {
      const frame = encodeMultiplexFrame(MULTIPLEX_STREAM.AUDIO_OUTPUT, buf, flags);
      this.send(frame);
      this.framesSent++;
      this.bytesSent += frame.length;
      return chunk;
    } catch (err) {
      this.sendErrors++;
      this.onSendError?.(
        err instanceof Error ? err : new Error(String(err)),
        chunk,
      );
      return chunk;
    }
  }

  /**
   * Send an end-of-message marker without any audio payload (e.g. when
   * the response ended on a non-audio modality).
   */
  endTurn(extraFlags = 0): void {
    try {
      const frame = encodeMultiplexFrame(
        MULTIPLEX_STREAM.AUDIO_OUTPUT,
        Buffer.alloc(0),
        MULTIPLEX_FLAG_EOM | extraFlags,
      );
      this.send(frame);
      this.framesSent++;
      this.bytesSent += frame.length;
    } catch (err) {
      this.sendErrors++;
      this.onSendError?.(
        err instanceof Error ? err : new Error(String(err)),
        { payload: Buffer.alloc(0), durationMs: 0, startMs: 0, endMs: 0 },
      );
    }
  }

  /**
   * Barge-in: truncate audio at `audioEndMs` along the playback timeline,
   * notify the client with an EOM frame, and report the truncate result
   * to the consumer.
   */
  truncateAt(audioEndMs: number): TruncateResult {
    const result = this.buffer.truncate(audioEndMs);
    this.truncations++;
    // Notify client to stop playback immediately; payload is empty + EOM.
    try {
      const frame = encodeMultiplexFrame(
        MULTIPLEX_STREAM.AUDIO_OUTPUT,
        Buffer.alloc(0),
        MULTIPLEX_FLAG_EOM,
      );
      this.send(frame);
      this.framesSent++;
      this.bytesSent += frame.length;
    } catch (err) {
      this.sendErrors++;
      this.onSendError?.(
        err instanceof Error ? err : new Error(String(err)),
        { payload: Buffer.alloc(0), durationMs: 0, startMs: 0, endMs: 0 },
      );
    }
    try {
      this.onTruncate?.(result);
    } catch {
      /* never let consumer errors poison the stream */
    }
    return result;
  }

  /** Reset to fresh state (new conversation turn / new session). */
  reset(): void {
    this.buffer.reset();
  }
}

export const AUDIO_OUTPUT_STREAM_ID = MULTIPLEX_STREAM.AUDIO_OUTPUT;
