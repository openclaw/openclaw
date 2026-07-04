// Close reason helpers keep WebSocket handshake failure text within RFC byte limits.
import { Buffer } from "node:buffer";

/**
 * WebSocket close reason utilities.
 */
const CLOSE_REASON_MAX_BYTES = 120;

/** Truncates close reasons to the RFC-safe byte limit used during handshake failures. */
export function truncateCloseReason(reason: string, maxBytes = CLOSE_REASON_MAX_BYTES): string {
  if (!reason) {
    return "invalid handshake";
  }
  const buf = Buffer.from(reason);
  if (buf.length <= maxBytes) {
    return reason;
  }
  const end = utf8BoundaryAtOrBefore(buf, maxBytes);
  return buf.subarray(0, end).toString();
}

function utf8BoundaryAtOrBefore(buf: Buffer, maxBytes: number): number {
  const limit = Math.max(0, Math.min(Math.floor(maxBytes), buf.length));
  let end = 0;

  while (end < limit) {
    const byte = buf[end];
    const charBytes = utf8SequenceLength(byte);
    if (end + charBytes > limit) {
      break;
    }
    end += charBytes;
  }

  return end;
}

function utf8SequenceLength(byte: number): number {
  if (byte < 0x80) {
    return 1;
  }
  if (byte < 0xe0) {
    return 2;
  }
  if (byte < 0xf0) {
    return 3;
  }
  return 4;
}
