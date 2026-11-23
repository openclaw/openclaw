import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { projectChatDisplayMessage } from "../../gateway/chat-display-projection.js";
import { deriveSessionUnread } from "../../shared/session-unread.js";
import type { SessionEntry } from "./types.js";

/**
 * Unread follows chat content: an appended user or assistant row the chat renders with something
 * to read makes a read session unread and ends a snooze. Silent replies, heartbeat prompts and
 * acknowledgements, wakes and hidden turns do not. A session that is already unread and awake has
 * nothing to change, so ordinary appends to it stay transcript-only writes.
 */
export function projectVisibleSessionActivity(
  entry: Pick<
    SessionEntry,
    "createdAt" | "lastReadAt" | "markedUnreadAt" | "lastActivityAt" | "snoozedUntil" | "snoozedAt"
  >,
  message: unknown,
  timestamp: unknown,
): Pick<SessionEntry, "lastActivityAt" | "snoozedUntil" | "snoozedAt"> | undefined {
  const at = parseDateFirstTimestampMs(timestamp) ?? Date.now();
  const baseline = entry.lastReadAt ?? entry.createdAt;
  const turnsUnread = baseline !== undefined && at > baseline && !deriveSessionUnread(entry);
  const wakes = entry.snoozedUntil !== undefined && at > (entry.snoozedAt ?? 0);
  if (!turnsUnread && !wakes) {
    return undefined;
  }
  const role = asOptionalRecord(message)?.role;
  const content =
    role === "user" || role === "assistant" ? projectChatDisplayMessage(message)?.content : null;
  const visible =
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.some((block) => {
        // Tool calls and reasoning show activity, not a message to read.
        const type = asOptionalRecord(block)?.type;
        return type !== "toolCall" && type !== "thinking";
      }));
  return visible
    ? {
        lastActivityAt: Math.max(entry.lastActivityAt ?? 0, at),
        snoozedUntil: undefined,
        snoozedAt: undefined,
      }
    : undefined;
}
