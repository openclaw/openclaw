import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import {
  asOptionalObjectRecord as readObjectRecord,
  asOptionalRecord as readRecord,
} from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { appendReplyMediaFailures, type ReplyMediaFailure } from "../auto-reply/reply-payload.js";
import { isToolCallContentType, isToolResultContentType } from "../chat/tool-content.js";
import { isMeaningfulMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";
import { isRelativeAssistantMediaReference, splitMediaOutput } from "../media/parse-output.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import {
  extractAssistantPhaseText,
  isAssistantTextContentBlockType as isAssistantTextContentType,
} from "../shared/chat-message-content.js";

export { isAssistantTextContentType };

export type RoleContentMessage = {
  role: string;
  content?: unknown;
};

export const DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 8_000;

export function projectReplyMediaFailureText(
  message: Record<string, unknown>,
): Record<string, unknown> {
  if (message.role !== "assistant") {
    return message;
  }
  const failures: ReplyMediaFailure[] = [];
  for (const value of Array.isArray(message.content) ? message.content : []) {
    const block = readRecord(value);
    const attachment =
      block?.type === "attachment_error" ? readRecord(block.attachment) : undefined;
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
    return message;
  }
  // Older text clients ignore new attachment codes. Rich clients prefer content;
  // retain their card and put the warning first so text bounds keep recovery guidance.
  const caption = extractAssistantPhaseText({ content: message.content, phase: message.phase });
  return {
    ...message,
    text: [appendReplyMediaFailures(undefined, failures), caption].filter(Boolean).join("\n"),
  };
}

/** Removes private yield inputs from a display copy without changing the source argument objects. */
export function stripPrivateToolCallContextForDisplay(entry: Record<string, unknown>): boolean {
  if (entry.type !== "toolCall" || entry.name !== "sessions_yield") {
    return false;
  }
  let changed = false;
  for (const field of ["arguments", "input"]) {
    const toolInput = readRecord(entry[field]);
    if (!toolInput || !("message" in toolInput)) {
      continue;
    }
    const { message: _, ...publicInput } = toolInput;
    entry[field] = publicInput;
    changed = true;
  }
  return changed;
}

export function takeAssistantManagedMediaUrlsForDisplay(
  entry: Record<string, unknown>,
  role: string,
): { changed: boolean; urls: string[] } {
  const delivery = role === "assistant" ? readRecord(entry.openclawDelivery) : undefined;
  const urls = Array.isArray(delivery?.mediaUrls)
    ? delivery.mediaUrls.filter((url): url is string => typeof url === "string")
    : [];
  if (!delivery || !Object.hasOwn(delivery, "mediaUrls")) {
    return { changed: false, urls };
  }
  const projectedDelivery = { ...delivery };
  delete projectedDelivery.mediaUrls;
  if (Object.keys(projectedDelivery).length > 0) {
    entry.openclawDelivery = projectedDelivery;
  } else {
    delete entry.openclawDelivery;
  }
  return { changed: true, urls };
}

/** Keeps managed attachment commands in the raw transcript while removing them from display text. */
export function stripAssistantMediaDirectivesForDisplay(
  text: string,
  managedMediaUrls: readonly string[],
): string {
  if (managedMediaUrls.length === 0 || !/(?:^|[\r\n])\s*MEDIA:/iu.test(text)) {
    return text;
  }
  const managed = new Set(managedMediaUrls.map((url) => url.trim()).filter(Boolean));
  const parsed = splitMediaOutput(text, {
    extractAudioDirectives: false,
  });
  if (
    !parsed.mediaUrls?.some(
      (url) => isRelativeAssistantMediaReference(url) && managed.has(url.trim()),
    )
  ) {
    return text;
  }
  return (parsed.segments ?? [])
    .filter(
      (segment) =>
        segment.type !== "media" ||
        !isRelativeAssistantMediaReference(segment.url) ||
        !managed.has(segment.url.trim()),
    )
    .map((segment) => (segment.type === "media" ? `MEDIA:${segment.url}` : segment.text))
    .join("\n");
}

export function resolveEffectiveChatHistoryMaxChars(maxChars?: number): number {
  if (typeof maxChars === "number") {
    return maxChars;
  }
  return DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
}

export function truncateChatHistoryText(
  text: string,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  preserveExactPrefix = false,
  toolResultMaxChars?: number,
): { text: string; truncated: boolean } {
  let limit = maxChars;
  if (toolResultMaxChars !== undefined && toolResultMaxChars < Math.min(text.length, maxChars)) {
    // Complete JSON drives source cards, Canvas, and structured output rendering.
    const preview = truncateUtf16Safe(text, maxChars);
    if (!/^\s*[[{]/u.test(preview) || safeParseJson(preview) === undefined) {
      limit = toolResultMaxChars;
    }
  }
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  const prefix = truncateUtf16Safe(text, limit);
  return {
    text: preserveExactPrefix ? prefix : `${prefix}\n...(truncated)...`,
    truncated: true,
  };
}

export function extractAssistantTextForSilentCheck(message: unknown): string | undefined {
  const entry = readObjectRecord(message);
  if (entry?.role !== "assistant") {
    return undefined;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (!Array.isArray(entry.content) || entry.content.length === 0) {
    return undefined;
  }

  const texts: string[] = [];
  for (const block of entry.content) {
    const typed = readObjectRecord(block);
    if (!typed) {
      return undefined;
    }
    if (isAssistantInternalReasoningContentType(typed.type)) {
      continue;
    }
    if (!isAssistantTextContentType(typed.type) || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

export function isAssistantInternalReasoningContentType(type: unknown): boolean {
  return type === "thinking" || type === "reasoning" || type === "redacted_thinking";
}

export function hasAssistantNonTextContent(message: unknown, includeReasoning = true): boolean {
  const content = readObjectRecord(message)?.content;
  return (
    Array.isArray(content) &&
    content.some((block) => {
      const entry = readObjectRecord(block);
      return (
        entry &&
        !isAssistantTextContentType(entry.type) &&
        (includeReasoning || !isAssistantInternalReasoningContentType(entry.type))
      );
    })
  );
}

export function hasAssistantDisplayableNonTextContent(message: unknown): boolean {
  return hasAssistantNonTextContent(message, false);
}

export function shouldPreserveAssistantControlReplyText(message: Record<string, unknown>): boolean {
  if (isProjectedForwardedMessage(message)) {
    return true;
  }
  return hasAssistantDisplayableNonTextContent(message);
}

export function asRoleContentMessage(message: Record<string, unknown>): RoleContentMessage | null {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (!role) {
    return null;
  }
  return {
    ...message,
    role,
    ...(message.content !== undefined
      ? { content: message.content }
      : message.text !== undefined
        ? { content: message.text }
        : {}),
  };
}

export function isEmptyTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  for (const block of content) {
    const entry = readObjectRecord(block);
    if (entry?.type !== "text" || typeof entry.text !== "string" || entry.text.trim().length > 0) {
      return false;
    }
  }
  return true;
}

export function hasTranscriptMediaFacts(message: Record<string, unknown>): boolean {
  return (readPersistedMediaFacts(message) ?? []).some(isMeaningfulMediaFact);
}

export function extractProjectedText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    const text = readObjectRecord(block)?.text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

export function isCronRunMessage(message: Record<string, unknown>): boolean {
  const provenance = normalizeInputProvenance(message.provenance);
  return (
    provenance?.kind === "internal_system" &&
    provenance.sourceTool === "cron" &&
    Boolean(provenance.jobId && provenance.runId && provenance.sourceSessionKey)
  );
}

export function isForwardedUserMessage(message: Record<string, unknown>): boolean {
  return message.role === "user" && hasForwardedMessageProvenance(message);
}

const TOOL_MESSAGE_ENVELOPE_FIELDS = [
  "toolCallId",
  "tool_call_id",
  "toolUseId",
  "tool_use_id",
  "toolName",
  "tool_name",
] as const;

/** Tool-shaped user rows display as tool results, so they do not start a chat turn. */
export function userMessageStartsDisplayTurn(message: Record<string, unknown>): boolean {
  if (TOOL_MESSAGE_ENVELOPE_FIELDS.some((field) => typeof message[field] === "string")) {
    return false;
  }
  return !Array.isArray(message.content)
    ? true
    : !message.content.some((block) => {
        const type = readRecord(block)?.type;
        return isToolCallContentType(type) || isToolResultContentType(type);
      });
}

export function isProjectedForwardedMessage(message: Record<string, unknown>): boolean {
  return message.role === "assistant" && hasForwardedMessageProvenance(message);
}

function hasForwardedMessageProvenance(message: Record<string, unknown>): boolean {
  const provenance = normalizeInputProvenance(message.provenance);
  return (
    (provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send") ||
    isCronRunMessage(message)
  );
}
