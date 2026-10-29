// Close reason helpers keep WebSocket handshake failure text within RFC byte limits.
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";

/** Truncates close reasons to the RFC-safe byte limit used during handshake failures. */
export function truncateCloseReason(reason: string): string {
  if (!reason) {
    return "invalid handshake";
  }
  return truncateUtf8Prefix(reason, 120);
}
