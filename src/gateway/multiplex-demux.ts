/**
 * Multiplex demultiplexer — routes decoded frames from a single binary
 * stream into per-streamId handlers, with optional buffering for partial
 * frames spanning multiple WebSocket message boundaries.
 *
 * Phase B.1 of streaming-multimodal: pure module, framework-agnostic. The
 * gateway WebSocket layer can call {@link MultiplexDemuxer.push} on every
 * inbound binary `Buffer` to dispatch any complete frames to the
 * registered handlers (one per streamId). Partial trailing bytes are
 * retained internally for the next push.
 */
import {
  decodeMultiplexFrames,
  isMultiplexedFrame,
  MULTIPLEX_FRAME_ENVELOPE_OVERHEAD,
  MULTIPLEX_FRAME_HEADER_SIZE,
  MULTIPLEX_FRAME_MAX_PAYLOAD,
  type MultiplexFrame,
} from "./multiplex-frame.js";

/** Error class specific to the demuxer (separate from the codec error). */
export class MultiplexDemuxError extends Error {
  readonly code: "BUFFER_OVERFLOW" | "HANDLER_THREW";

  constructor(code: MultiplexDemuxError["code"], message: string) {
    super(`[multiplex-demux:${code}] ${message}`);
    this.name = "MultiplexDemuxError";
    this.code = code;
  }
}

/** Maximum bytes the demuxer will buffer waiting for a complete frame. */
export const MULTIPLEX_DEMUX_DEFAULT_MAX_BUFFER_BYTES =
  MULTIPLEX_FRAME_MAX_PAYLOAD + MULTIPLEX_FRAME_ENVELOPE_OVERHEAD + 1024;

/** Handler invoked for every successfully decoded frame on a streamId. */
export type MultiplexFrameHandler = (frame: MultiplexFrame) => void;

/** Handler invoked when an unknown streamId is seen. Defaults to silent drop. */
export type MultiplexUnknownStreamHandler = (frame: MultiplexFrame) => void;

/** Handler invoked when decoding fails partway through a buffer. */
export type MultiplexErrorHandler = (error: Error, context: { totalBytesBuffered: number }) => void;

export interface MultiplexDemuxerOptions {
  /** Per-streamId handlers. */
  handlers?: Record<number, MultiplexFrameHandler>;
  /** Fallback for unrecognized streamIds. */
  onUnknownStream?: MultiplexUnknownStreamHandler;
  /** Called with any decode error (frame is dropped, demuxer continues). */
  onError?: MultiplexErrorHandler;
  /** Hard cap on internal buffer size (defaults to MAX_PAYLOAD + overhead). */
  maxBufferBytes?: number;
}

/**
 * Stateful demuxer. Maintains a small carry buffer for partial frames and
 * dispatches complete frames to handlers as they decode.
 */
export class MultiplexDemuxer {
  private readonly handlers: Map<number, MultiplexFrameHandler>;
  private readonly onUnknownStream?: MultiplexUnknownStreamHandler;
  private readonly onError?: MultiplexErrorHandler;
  private readonly maxBufferBytes: number;
  private carry: Buffer = Buffer.alloc(0);
  private framesDispatched = 0;
  private bytesProcessed = 0;
  private decodeErrors = 0;

  constructor(options: MultiplexDemuxerOptions = {}) {
    this.handlers = new Map();
    if (options.handlers) {
      for (const [key, value] of Object.entries(options.handlers)) {
        const id = Number(key);
        if (Number.isFinite(id)) {
          this.handlers.set(id, value);
        }
      }
    }
    this.onUnknownStream = options.onUnknownStream;
    this.onError = options.onError;
    this.maxBufferBytes = options.maxBufferBytes ?? MULTIPLEX_DEMUX_DEFAULT_MAX_BUFFER_BYTES;
  }

  /**
   * Register / replace the handler for a streamId.
   */
  on(streamId: number, handler: MultiplexFrameHandler): void {
    if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xff) {
      throw new RangeError(`invalid streamId ${streamId}`);
    }
    this.handlers.set(streamId, handler);
  }

  /** Remove a streamId handler. */
  off(streamId: number): void {
    this.handlers.delete(streamId);
  }

  /** Total frames successfully dispatched. */
  get stats(): {
    framesDispatched: number;
    bytesProcessed: number;
    decodeErrors: number;
    bufferedBytes: number;
  } {
    return {
      framesDispatched: this.framesDispatched,
      bytesProcessed: this.bytesProcessed,
      decodeErrors: this.decodeErrors,
      bufferedBytes: this.carry.length,
    };
  }

  /** Discard any partially buffered data (e.g. on session reset). */
  reset(): void {
    this.carry = Buffer.alloc(0);
  }

  /**
   * Feed a chunk of bytes. Any complete frames are dispatched synchronously;
   * remaining trailing bytes are retained. Returns the number of frames
   * dispatched from this call.
   */
  push(data: Buffer | Uint8Array): number {
    const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.bytesProcessed += incoming.length;

    // Combine with any carried partial frame.
    const combined = this.carry.length > 0 ? Buffer.concat([this.carry, incoming]) : incoming;

    if (combined.length > this.maxBufferBytes) {
      // Hard cap to prevent runaway memory if a peer streams junk that
      // never decodes. Reset and surface an error.
      this.carry = Buffer.alloc(0);
      const err = new MultiplexDemuxError(
        "BUFFER_OVERFLOW",
        `multiplex demuxer buffer exceeded ${this.maxBufferBytes} bytes`,
      );
      this.decodeErrors += 1;
      this.onError?.(err, { totalBytesBuffered: combined.length });
      return 0;
    }

    let dispatchedThisCall = 0;
    let result: { frames: MultiplexFrame[]; remainder: Buffer };
    try {
      result = decodeMultiplexFrames(combined);
    } catch (err) {
      // Decode error mid-buffer: drop the entire buffered region (we can't
      // safely re-sync without a magic byte scan; the codec already rejects
      // anything not starting with 0xFE). Surface and reset.
      this.carry = Buffer.alloc(0);
      this.decodeErrors += 1;
      this.onError?.(err instanceof Error ? err : new Error(String(err)), {
        totalBytesBuffered: combined.length,
      });
      return 0;
    }

    this.carry = result.remainder;

    for (const frame of result.frames) {
      const handler = this.handlers.get(frame.streamId);
      if (handler) {
        try {
          handler(frame);
        } catch (err) {
          // A handler throwing must not poison the demuxer.
          this.decodeErrors += 1;
          this.onError?.(err instanceof Error ? err : new Error(String(err)), {
            totalBytesBuffered: this.carry.length,
          });
          continue;
        }
      } else if (this.onUnknownStream) {
        try {
          this.onUnknownStream(frame);
        } catch {
          /* ignore unknown-stream handler errors */
        }
      }
      this.framesDispatched += 1;
      dispatchedThisCall += 1;
    }

    return dispatchedThisCall;
  }
}

/**
 * Convenience guard: returns true if `data` looks like a multiplexed binary
 * frame (starts with the magic byte and has at least the header). The full
 * codec performs strict validation; this is a cheap pre-filter.
 */
export function looksLikeMultiplexedTraffic(data: unknown): boolean {
  if (!isMultiplexedFrame(data)) {
    return false;
  }
  const buf = data;
  return buf.length >= 1 + MULTIPLEX_FRAME_HEADER_SIZE;
}
