/**
 * Audio input stream handler — Phase B.2.
 *
 * Bridges the multiplex demuxer (streamId AUDIO_INPUT) to the
 * {@link RealtimeInputBuffer} primitive from Phase A.2. Incoming frame
 * payloads are appended as PCM16 LE chunks; an EOM flag triggers a
 * `commit()` and the resulting audio is delivered to the consumer
 * (typically the realtime provider adapter) via {@link onCommit}.
 *
 * This handler is framework-agnostic: it has no I/O of its own. Wire it
 * into a {@link MultiplexDemuxer} via `demux.on(MULTIPLEX_STREAM.AUDIO_INPUT,
 * audioIn.handleFrame)`.
 */
import {
  RealtimeInputBuffer,
  type AudioFormat,
  type CommitResult,
  type RealtimeInputBufferOptions,
} from "./input-buffer.js";
import {
  frameHasEom,
  MULTIPLEX_STREAM,
  type MultiplexFrame,
} from "../multiplex-frame.js";

export interface AudioInputStreamOptions extends RealtimeInputBufferOptions {
  /**
   * Called when an EOM-flagged frame is received and the buffer commits.
   * Receives the committed audio plus duration metadata.
   */
  onCommit?: (result: CommitResult) => void;
  /**
   * Called for any frame whose payload is rejected (e.g. odd byte length
   * for PCM16). Defaults to silently dropping the frame.
   */
  onInvalidFrame?: (error: Error, frame: MultiplexFrame) => void;
}

/**
 * Per-session AudioInput stream handler. Owns one {@link RealtimeInputBuffer}.
 */
export class AudioInputStream {
  /** Stream id this handler is responsible for. */
  static readonly STREAM_ID = MULTIPLEX_STREAM.AUDIO_INPUT;

  readonly buffer: RealtimeInputBuffer;
  private readonly onCommit?: (result: CommitResult) => void;
  private readonly onInvalidFrame?: (error: Error, frame: MultiplexFrame) => void;
  private framesAccepted = 0;
  private bytesAccepted = 0;
  private commitsEmitted = 0;
  private framesRejected = 0;

  constructor(options: AudioInputStreamOptions = {}) {
    const { onCommit, onInvalidFrame, ...bufferOptions } = options;
    this.buffer = new RealtimeInputBuffer(bufferOptions);
    this.onCommit = onCommit;
    this.onInvalidFrame = onInvalidFrame;
  }

  /** Accessor for the underlying audio format. */
  get format(): AudioFormat {
    return this.buffer.format;
  }

  /** Telemetry snapshot. */
  get stats(): {
    framesAccepted: number;
    bytesAccepted: number;
    commitsEmitted: number;
    framesRejected: number;
    bufferedBytes: number;
    bufferedMs: number;
    isSpeaking: boolean;
  } {
    return {
      framesAccepted: this.framesAccepted,
      bytesAccepted: this.bytesAccepted,
      commitsEmitted: this.commitsEmitted,
      framesRejected: this.framesRejected,
      bufferedBytes: this.buffer.getBufferedBytes(),
      bufferedMs: this.buffer.getBufferedDurationMs(),
      isSpeaking: this.buffer.isSpeaking(),
    };
  }

  /**
   * Frame handler suitable for direct registration with a
   * {@link MultiplexDemuxer}. Bound to `this` for convenience.
   */
  readonly handleFrame = (frame: MultiplexFrame): void => {
    if (frame.streamId !== MULTIPLEX_STREAM.AUDIO_INPUT) {
      // Defensive: caller mis-routed.
      this.framesRejected++;
      this.onInvalidFrame?.(
        new Error(
          `AudioInputStream received frame for streamId ${frame.streamId} (expected ${MULTIPLEX_STREAM.AUDIO_INPUT})`,
        ),
        frame,
      );
      return;
    }

    if (frame.payload.length > 0) {
      try {
        this.buffer.append(frame.payload);
        this.framesAccepted++;
        this.bytesAccepted += frame.payload.length;
      } catch (err) {
        this.framesRejected++;
        this.onInvalidFrame?.(
          err instanceof Error ? err : new Error(String(err)),
          frame,
        );
        return;
      }
    } else {
      // Empty payload still counts as a received frame (heartbeat/EOM-only).
      this.framesAccepted++;
    }

    if (frameHasEom(frame.flags)) {
      this.commit();
    }
  };

  /**
   * Force a commit (e.g. on session end or explicit client request).
   * Returns the committed audio or `null` if the buffer was empty.
   */
  commit(): CommitResult | null {
    if (this.buffer.getBufferedBytes() === 0) {
      return null;
    }
    const result = this.buffer.commit();
    this.commitsEmitted++;
    try {
      this.onCommit?.(result);
    } catch {
      /* never let consumer errors poison the stream */
    }
    return result;
  }

  /** Discard any buffered audio without emitting a commit. */
  clear(): void {
    this.buffer.clear();
  }
}

/** Default export convenience for symmetry with the codec module. */
export const AUDIO_INPUT_STREAM_ID = MULTIPLEX_STREAM.AUDIO_INPUT;
