// openclaw/tunnel/1 framing over iroh streams: 4-byte big-endian length +
// payload. Reads gather Buffers without re-copying the whole backlog; writes
// await QUIC flow control, which is the backpressure toward the Gateway.
import {
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_HTTP_DATA_FRAME_BYTES,
  TunnelProtocolError,
} from "../../../../packages/openclaw-id-protocol/src/index.js";
import type { IrohRecvStream, IrohSendStream } from "./addon.js";

// Read size requested per call; the binding gathers whatever QUIC already holds.
const READ_CHUNK = 1 << 20;

/** Reads whole frames from a RecvStream. */
export class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private eof = false;

  constructor(private readonly recv: IrohRecvStream) {}

  // Pulls one chunk; false at end of stream.
  private async fill(): Promise<boolean> {
    if (this.eof) {
      return false;
    }
    const chunk = await this.recv.read(READ_CHUNK);
    if (!chunk || chunk.length === 0) {
      this.eof = true;
      return false;
    }
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    return true;
  }

  // Removes exactly n buffered bytes (n <= buffered).
  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    this.chunks = n < all.length ? [all.subarray(n)] : [];
    this.buffered -= n;
    return all.subarray(0, n);
  }

  /**
   * Next frame payload, or null when the peer finished at a frame boundary.
   * Throws TunnelProtocolError on a truncated or oversized frame.
   */
  async next(maxBytes = MAX_FRAME_BYTES): Promise<Buffer | null> {
    while (this.buffered < FRAME_HEADER_BYTES) {
      if (!(await this.fill())) {
        if (this.buffered === 0) {
          return null;
        }
        throw new TunnelProtocolError("truncated frame header");
      }
    }
    const length = this.take(FRAME_HEADER_BYTES).readUInt32BE(0);
    if (length > maxBytes) {
      throw new TunnelProtocolError(`frame of ${length} bytes exceeds ${maxBytes}`);
    }
    while (this.buffered < length) {
      if (!(await this.fill())) {
        throw new TunnelProtocolError("truncated frame");
      }
    }
    return Buffer.from(this.take(length));
  }
}

/** Writes one frame (a HEAD or a WebSocket message). */
export async function writeFrame(send: IrohSendStream, payload: Uint8Array): Promise<void> {
  if (payload.length > MAX_FRAME_BYTES) {
    throw new TunnelProtocolError("frame too large");
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  // Small frames go out in one write; large ones skip the concatenation copy.
  if (payload.length < 64 * 1024) {
    await send.write(Buffer.concat([header, payload]));
  } else {
    await send.write(header);
    await send.write(payload);
  }
}

/** Writes an HTTP body chunk as DATA frames of at most 1 MiB. */
export async function writeDataFrames(send: IrohSendStream, payload: Buffer): Promise<void> {
  for (let offset = 0; offset < payload.length; offset += MAX_HTTP_DATA_FRAME_BYTES) {
    await writeFrame(send, payload.subarray(offset, offset + MAX_HTTP_DATA_FRAME_BYTES));
  }
}
