import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatReplyTarget } from "./chat-types.ts";

export function isChatReplyTarget(value: unknown): value is ChatReplyTarget {
  return (
    isRecord(value) &&
    typeof value.messageId === "string" &&
    value.messageId.length > 0 &&
    typeof value.text === "string" &&
    (value.senderLabel == null || typeof value.senderLabel === "string") &&
    (value.sourceMessageId == null || typeof value.sourceMessageId === "string")
  );
}
