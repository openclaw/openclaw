import { Buffer } from "node:buffer";

const CLOSE_REASON_MAX_BYTES = 120;

/** Truncates websocket close reasons to fit protocol byte limits. */
export function truncateCloseReason(reason: string, maxBytes = CLOSE_REASON_MAX_BYTES): string {
  if (!reason) {
    return "invalid handshake";
  }
  const buf = Buffer.from(reason);
  if (buf.length <= maxBytes) {
    return reason;
  }
  // Decode the byte slice back to UTF-8 so callers never send raw partial bytes
  // in close frames; invalid trailing code units are replaced by Buffer.
  return buf.subarray(0, maxBytes).toString();
}
