import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { projectChatDisplayMessage } from "../../gateway/chat-display-projection.js";
import type { SessionEntry } from "./types.js";

/**
 * Unread follows chat content: an appended user or assistant row the chat renders with something
 * to read advances activity and ends a snooze. Silent replies, heartbeat prompts and
 * acknowledgements, wakes and hidden turns do not.
 */
export function projectVisibleSessionActivity(
  entry: Pick<SessionEntry, "lastActivityAt">,
  message: unknown,
  timestamp: unknown,
): Pick<SessionEntry, "lastActivityAt" | "snoozedUntil" | "snoozedAt"> | undefined {
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
  const at = parseDateFirstTimestampMs(timestamp) ?? Date.now();
  return visible && at > (entry.lastActivityAt ?? 0)
    ? { lastActivityAt: at, snoozedUntil: undefined, snoozedAt: undefined }
    : undefined;
}
