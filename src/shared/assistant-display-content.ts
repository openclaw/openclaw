import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { appendReplyMediaFailures, type ReplyMediaFailure } from "../auto-reply/reply-payload.js";
import type { AssistantMessage } from "../llm/types.js";
import { extractAssistantPhaseText } from "./chat-message-content.js";

export const ASSISTANT_DISPLAY_CONTENT_FIELD = "openclawDisplayContent";

type AssistantModelContentBlock = AssistantMessage["content"][number];

function isAssistantModelContentBlock(value: unknown): value is AssistantModelContentBlock {
  const block = asOptionalRecord(value);
  if (!block) {
    return false;
  }
  if (block.type === "text") {
    return typeof block.text === "string";
  }
  if (block.type === "thinking") {
    return typeof block.thinking === "string";
  }
  return (
    block.type === "toolCall" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    asOptionalRecord(block.arguments) !== undefined
  );
}

export function retainAssistantModelContent(
  blocks: readonly unknown[],
): AssistantMessage["content"] {
  return blocks.filter(isAssistantModelContentBlock).map((block) => Object.assign({}, block));
}

export function readAssistantDisplayContent(message: unknown): Record<string, unknown>[] {
  const record = asOptionalRecord(message);
  if (!record) {
    return [];
  }
  const display = record[ASSISTANT_DISPLAY_CONTENT_FIELD];
  const content = Array.isArray(display) ? display : record.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

export function projectAssistantDisplayContent(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const display = message[ASSISTANT_DISPLAY_CONTENT_FIELD];
  if (message.role !== "assistant") {
    return message;
  }
  let projected = message;
  if (Array.isArray(display)) {
    const { [ASSISTANT_DISPLAY_CONTENT_FIELD]: _, ...rest } = message;
    projected = { ...rest, content: display };
  }
  const failures: ReplyMediaFailure[] = [];
  for (const value of Array.isArray(projected.content) ? projected.content : []) {
    const block = asOptionalRecord(value);
    const attachment =
      block?.type === "attachment_error" ? asOptionalRecord(block.attachment) : undefined;
    const kind = attachment?.kind;
    if (
      attachment?.code === "file-too-large" &&
      (kind === "image" || kind === "audio" || kind === "video" || kind === "document")
    ) {
      failures.push({
        code: "file-too-large",
        kind,
        label: `${kind === "document" ? "file" : kind} attachment`,
      });
    }
  }
  if (failures.length === 0) {
    return projected;
  }
  // Older text clients ignore new attachment codes. Rich clients prefer content;
  // retain their card and put the warning first so text bounds keep recovery guidance.
  const caption = extractAssistantPhaseText({ content: projected.content, phase: projected.phase });
  return {
    ...projected,
    text: [appendReplyMediaFailures(undefined, failures), caption].filter(Boolean).join("\n"),
  };
}
