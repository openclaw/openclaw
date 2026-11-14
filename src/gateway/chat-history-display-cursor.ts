import { randomUUID } from "node:crypto";
import { readUserProfileVersion } from "../state/user-profile-events.js";

// Profile/link edits change cached messages without a transcript event. The
// process identity also prevents a restarted revision counter reusing a cursor.
const displayCursorEpoch = randomUUID();

/** A display cache key, never authority; stale cursors use the existing page reset. */
export function createChatHistoryDisplayCursor() {
  // A profile change during an admitted read is picked up by the next request.
  const prefix = "history-display:" + displayCursorEpoch + ":" + readUserProfileVersion() + ":";
  return {
    // Empty is an invalid raw cursor: the transcript reader already returns reset.
    read: (cursor: string) => (cursor.startsWith(prefix) ? cursor.slice(prefix.length) : ""),
    write: (cursor?: string) => (cursor ? { deltaCursor: prefix + cursor } : {}),
  };
}
