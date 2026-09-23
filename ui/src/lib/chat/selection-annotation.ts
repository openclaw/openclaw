import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatSelectionAnnotation } from "./chat-types.ts";

/** Reads optional annotation presentation metadata without discarding its file payload. */
export function readChatSelectionAnnotation(value: unknown): ChatSelectionAnnotation | undefined {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    typeof value.comment !== "string" ||
    typeof value.sessionKey !== "string" ||
    typeof value.start !== "number" ||
    !Number.isSafeInteger(value.start) ||
    value.start < 0 ||
    typeof value.end !== "number" ||
    !Number.isSafeInteger(value.end) ||
    value.end < value.start ||
    (value.messageId !== undefined && typeof value.messageId !== "string") ||
    (value.entryId !== undefined && typeof value.entryId !== "string")
  ) {
    return undefined;
  }
  return {
    text: value.text,
    comment: value.comment,
    sessionKey: value.sessionKey,
    start: value.start,
    end: value.end,
    ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
    ...(typeof value.entryId === "string" ? { entryId: value.entryId } : {}),
  };
}
