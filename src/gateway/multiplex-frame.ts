/**
 * Multiplex Frame Codec — Phase A.1 of Streaming Multimodal foundation.
 *
 * Binary frame format (little-endian where applicable):
 *
 *   ┌─────────┬──────────┬─────────────┬──────────────┐
 *   │ Stream  │ Flags    │ Payload Len │ Payload      │
 *   │ ID (1B) │ (1B)     │ (4B LE)     │ (variable)   │
 *   └─────────┴──────────┴─────────────┴──────────────┘
 *
 * Stream IDs (well-known):
 *   0   = Control (JSON events: session.update, response.create, ...)
 *   1   = Audio Input  (PCM chunks, base64 inside or raw bytes)
 *   2   = Audio Output (PCM chunks)
 *   3   = Video Input  (Phase C)
 *   4   = Video Output (Phase C)
 *   5+  = Reserved
 *
 * Flags (bitmask):
 *   0x01 = EOM       — End of message / flush hint for the stream
 *   0x02 = PRIORITY  — Low-latency / urgent
 *   0x04 = COMPRESSED — Payload is gzip-compressed (codec-agnostic)
 *
 * Header is fixed at 6 bytes; payload is bounded to 16 MiB (per A.1 acceptance
 * criteria). Frame overhead is < 10 bytes (6 bytes here).
 *
 * Backward compatibility note: callers detect multiplex frames via the
 * `MULTIPLEX_FRAME_MAGIC` byte at offset 0 of the WebSocket message *prefix*
 * sentinel — see `isMultiplexedFrame`. Legacy JSON/text payloads start with
 * `{`, `[`, or whitespace, so the magic byte is chosen outside that range.
 */

/** Header size in bytes: 1 (streamId) + 1 (flags) + 4 (payload length). */
export const MULTIPLEX_FRAME_HEADER_SIZE = 6;

/** Maximum payload size (16 MiB). */
export const MULTIPLEX_FRAME_MAX_PAYLOAD = 16 * 1024 * 1024;

/** Maximum stream id (single byte). */
export const MULTIPLEX_FRAME_MAX_STREAM_ID = 0xff;

/** Maximum flags value (single byte). */
export const MULTIPLEX_FRAME_MAX_FLAGS = 0xff;

/**
 * Sentinel "magic" byte distinguishing multiplex frames from legacy
 * JSON/text payloads. Multiplex framing is opt-in via a 1-byte prefix:
 *
 *   [MAGIC] [streamId] [flags] [len32 LE] [payload...]
 *
 * The magic byte (0xFE) cannot appear at the start of a valid UTF-8 JSON
 * document or whitespace-prefixed payload, so detection is unambiguous.
 *
 * NOTE: This is the *transport-envelope* magic — the on-the-wire layout has
 * a leading magic byte so legacy non-multiplex clients keep working. The
 * canonical 6-byte header described in the comment above sits *after* the
 * magic byte.
 */
export const MULTIPLEX_FRAME_MAGIC = 0xfe;

/** Total envelope overhead including the magic byte. */
export const MULTIPLEX_FRAME_ENVELOPE_OVERHEAD = 1 + MULTIPLEX_FRAME_HEADER_SIZE;

/** Flag bit: payload represents end-of-message for the stream. */
export const MULTIPLEX_FLAG_EOM = 0x01;
/** Flag bit: payload should be processed with low-latency priority. */
export const MULTIPLEX_FLAG_PRIORITY = 0x02;
/** Flag bit: payload bytes are gzip-compressed. */
export const MULTIPLEX_FLAG_COMPRESSED = 0x04;

/** Mask of all defined flag bits. Reserved bits MUST be 0 by encoders. */
export const MULTIPLEX_FLAG_DEFINED_MASK =
  MULTIPLEX_FLAG_EOM | MULTIPLEX_FLAG_PRIORITY | MULTIPLEX_FLAG_COMPRESSED;

/** Well-known stream IDs (extensible by callers). */
export const MULTIPLEX_STREAM = Object.freeze({
  CONTROL: 0,
  AUDIO_INPUT: 1,
  AUDIO_OUTPUT: 2,
  VIDEO_INPUT: 3,
  VIDEO_OUTPUT: 4,
} as const);

/** Decoded frame contents. */
export interface MultiplexFrame {
  streamId: number;
  flags: number;
  payload: Buffer;
}

/** Errors emitted by the codec. Carry a stable `code` for routing. */
export class MultiplexFrameError extends Error {
  readonly code:
    | "INVALID_STREAM_ID"
    | "INVALID_FLAGS"
    | "PAYLOAD_TOO_LARGE"
    | "TRUNCATED_HEADER"
    | "TRUNCATED_PAYLOAD"
    | "MISSING_MAGIC"
    | "INVALID_INPUT";

  constructor(code: MultiplexFrameError["code"], message: string) {
    super(`[multiplex-frame:${code}] ${message}`);
    this.name = "MultiplexFrameError";
    this.code = code;
  }
}

function assertValidHeaderInputs(streamId: number, flags: number, payloadLength: number): void {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MULTIPLEX_FRAME_MAX_STREAM_ID) {
    throw new MultiplexFrameError(
      "INVALID_STREAM_ID",
      `streamId must be an integer in [0, ${MULTIPLEX_FRAME_MAX_STREAM_ID}], got ${streamId}`,
    );
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > MULTIPLEX_FRAME_MAX_FLAGS) {
    throw new MultiplexFrameError(
      "INVALID_FLAGS",
      `flags must be an integer in [0, ${MULTIPLEX_FRAME_MAX_FLAGS}], got ${flags}`,
    );
  }
  if (payloadLength < 0 || payloadLength > MULTIPLEX_FRAME_MAX_PAYLOAD) {
    throw new MultiplexFrameError(
      "PAYLOAD_TOO_LARGE",
      `payload length ${payloadLength} exceeds max ${MULTIPLEX_FRAME_MAX_PAYLOAD}`,
    );
  }
}

/**
 * Encode a multiplex frame into a Buffer ready for WebSocket transmission.
 *
 * The output is `[MAGIC][streamId][flags][len32 LE][payload]`. Pass the
 * resulting buffer directly to `socket.send(buf, { binary: true })`.
 */
export function encodeMultiplexFrame(
  streamId: number,
  payload: Buffer | Uint8Array,
  flags: number = 0,
): Buffer {
  if (!(payload instanceof Uint8Array)) {
    throw new MultiplexFrameError("INVALID_INPUT", "payload must be a Buffer or Uint8Array");
  }
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  assertValidHeaderInputs(streamId, flags, payloadBuf.length);

  const out = Buffer.allocUnsafe(MULTIPLEX_FRAME_ENVELOPE_OVERHEAD + payloadBuf.length);
  out[0] = MULTIPLEX_FRAME_MAGIC;
  out[1] = streamId & 0xff;
  out[2] = flags & 0xff;
  out.writeUInt32LE(payloadBuf.length, 3);
  payloadBuf.copy(out, MULTIPLEX_FRAME_ENVELOPE_OVERHEAD);
  return out;
}

/**
 * Cheap detector: returns true when `data` looks like a multiplex frame
 * envelope. Intended for the WS message handler to choose between the
 * legacy text/JSON path and the new multiplex router.
 */
export function isMultiplexedFrame(data: unknown): data is Buffer | Uint8Array {
  if (!(data instanceof Uint8Array)) {
    return false;
  }
  if (data.length < MULTIPLEX_FRAME_ENVELOPE_OVERHEAD) {
    return false;
  }
  return data[0] === MULTIPLEX_FRAME_MAGIC;
}

/**
 * Decode a single multiplex frame. Throws `MultiplexFrameError` on any
 * structural problem (missing magic, truncated header, oversized payload).
 *
 * If `data` contains exactly one frame, the result's `payload` is a view
 * into a fresh buffer (safe to retain). Trailing bytes after the declared
 * payload length are rejected — use `decodeMultiplexFrames` for streams.
 */
export function decodeMultiplexFrame(data: Buffer | Uint8Array): MultiplexFrame {
  if (!(data instanceof Uint8Array)) {
    throw new MultiplexFrameError("INVALID_INPUT", "data must be a Buffer or Uint8Array");
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 1 || buf[0] !== MULTIPLEX_FRAME_MAGIC) {
    throw new MultiplexFrameError(
      "MISSING_MAGIC",
      "frame does not start with multiplex magic byte",
    );
  }
  if (buf.length < MULTIPLEX_FRAME_ENVELOPE_OVERHEAD) {
    throw new MultiplexFrameError(
      "TRUNCATED_HEADER",
      `frame too short for header: ${buf.length} < ${MULTIPLEX_FRAME_ENVELOPE_OVERHEAD}`,
    );
  }
  const streamId = buf[1];
  const flags = buf[2];
  const payloadLength = buf.readUInt32LE(3);
  assertValidHeaderInputs(streamId, flags, payloadLength);

  const expectedTotal = MULTIPLEX_FRAME_ENVELOPE_OVERHEAD + payloadLength;
  if (buf.length < expectedTotal) {
    throw new MultiplexFrameError(
      "TRUNCATED_PAYLOAD",
      `frame payload truncated: have ${buf.length - MULTIPLEX_FRAME_ENVELOPE_OVERHEAD} of ${payloadLength}`,
    );
  }
  if (buf.length > expectedTotal) {
    throw new MultiplexFrameError(
      "TRUNCATED_PAYLOAD",
      `unexpected trailing bytes after frame: ${buf.length - expectedTotal} extra`,
    );
  }

  // Copy the payload so callers can mutate / retain it without aliasing the input.
  const payload = Buffer.allocUnsafe(payloadLength);
  buf.copy(payload, 0, MULTIPLEX_FRAME_ENVELOPE_OVERHEAD, expectedTotal);
  return { streamId, flags, payload };
}

/**
 * Decode zero or more concatenated multiplex frames from a stream-style
 * buffer. Returns the parsed frames and any unparsed trailing bytes
 * (suitable for re-buffering when called again with new data).
 *
 * This is the building block for the gateway WS multiplex handler (A.3).
 */
export function decodeMultiplexFrames(data: Buffer | Uint8Array): {
  frames: MultiplexFrame[];
  remainder: Buffer;
} {
  if (!(data instanceof Uint8Array)) {
    throw new MultiplexFrameError("INVALID_INPUT", "data must be a Buffer or Uint8Array");
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const frames: MultiplexFrame[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf[offset] !== MULTIPLEX_FRAME_MAGIC) {
      throw new MultiplexFrameError(
        "MISSING_MAGIC",
        `expected magic byte at offset ${offset}, got 0x${buf[offset].toString(16)}`,
      );
    }
    if (buf.length - offset < MULTIPLEX_FRAME_ENVELOPE_OVERHEAD) {
      // Header incomplete — buffer for next chunk.
      break;
    }
    const streamId = buf[offset + 1];
    const flags = buf[offset + 2];
    const payloadLength = buf.readUInt32LE(offset + 3);
    assertValidHeaderInputs(streamId, flags, payloadLength);
    const frameTotal = MULTIPLEX_FRAME_ENVELOPE_OVERHEAD + payloadLength;
    if (buf.length - offset < frameTotal) {
      // Payload incomplete — buffer for next chunk.
      break;
    }
    const payload = Buffer.allocUnsafe(payloadLength);
    buf.copy(payload, 0, offset + MULTIPLEX_FRAME_ENVELOPE_OVERHEAD, offset + frameTotal);
    frames.push({ streamId, flags, payload });
    offset += frameTotal;
  }
  const remainder = offset === buf.length ? Buffer.alloc(0) : buf.subarray(offset);
  // Return a copy of the remainder so callers can safely retain it without
  // aliasing the (potentially pooled) input buffer.
  return { frames, remainder: Buffer.from(remainder) };
}

/** Convenience helper: true if `flags` includes EOM bit. */
export function frameHasEom(flags: number): boolean {
  return (flags & MULTIPLEX_FLAG_EOM) === MULTIPLEX_FLAG_EOM;
}

/** Convenience helper: true if `flags` includes PRIORITY bit. */
export function frameHasPriority(flags: number): boolean {
  return (flags & MULTIPLEX_FLAG_PRIORITY) === MULTIPLEX_FLAG_PRIORITY;
}

/** Convenience helper: true if `flags` includes COMPRESSED bit. */
export function frameHasCompressed(flags: number): boolean {
  return (flags & MULTIPLEX_FLAG_COMPRESSED) === MULTIPLEX_FLAG_COMPRESSED;
}
