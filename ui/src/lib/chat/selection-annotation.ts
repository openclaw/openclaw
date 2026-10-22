import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatFileSelection, ChatSelectionAnnotation } from "./chat-types.ts";

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
  let file: ChatFileSelection | undefined;
  if (value.file !== undefined) {
    const source = value.file;
    if (
      !isRecord(source) ||
      typeof source.path !== "string" ||
      typeof source.startLine !== "number" ||
      !Number.isSafeInteger(source.startLine) ||
      source.startLine < 1 ||
      typeof source.endLine !== "number" ||
      !Number.isSafeInteger(source.endLine) ||
      source.endLine < source.startLine ||
      (source.side !== undefined && source.side !== "old" && source.side !== "new")
    ) {
      return undefined;
    }
    file = {
      path: source.path,
      startLine: source.startLine,
      endLine: source.endLine,
      ...(source.side === "old" || source.side === "new" ? { side: source.side } : {}),
    };
  }
  let pdf: ChatSelectionAnnotation["pdf"];
  if (value.pdf !== undefined) {
    const source = value.pdf;
    if (
      !isRecord(source) ||
      typeof source.name !== "string" ||
      typeof source.page !== "number" ||
      !Number.isSafeInteger(source.page) ||
      source.page < 1
    ) {
      return undefined;
    }
    pdf = { name: source.name, page: source.page };
  }
  return {
    ...(pdf ? { pdf } : {}),
    ...(file ? { file } : {}),
    text: value.text,
    comment: value.comment,
    sessionKey: value.sessionKey,
    start: value.start,
    end: value.end,
    ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
    ...(typeof value.entryId === "string" ? { entryId: value.entryId } : {}),
  };
}
