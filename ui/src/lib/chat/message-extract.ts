import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { stripInternalRuntimeContext } from "../../../../src/agents/internal-runtime-context.js";
import { stripUserEnvelopeForDisplay } from "../../../../src/auto-reply/reply/user-envelope-display.js";
import { projectImportedMessageForDisplay } from "../../../../src/chat/session-catalog-display.js";
import { projectChatWorkContextForDisplay } from "../../../../src/chat/work-context.js";
import { readPersistedMediaFacts } from "../../../../src/media/media-facts.js";
import { stripEnvelope } from "../../../../src/shared/chat-envelope.js";
import { extractAssistantPhaseText } from "../../../../src/shared/chat-message-content.js";
import { stripAssistantMessageText } from "./assistant-message-text.ts";

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

export function extractText(message: unknown): string | null {
  // Chat events may carry no message at all (tool-only or heartbeat finals);
  // a nullish message means "no text", never a crash.
  if (message == null) {
    return null;
  }
  const projected = projectChatWorkContextForDisplay(projectImportedMessageForDisplay(message));
  const m = projected as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const raw =
    role === "assistant" ? extractAssistantPhaseText(projected) : extractRawText(projected);
  if (!raw) {
    return null;
  }
  const shouldStripInboundMetadata = normalizeLowercaseStringOrEmpty(role) === "user";
  const withoutInternalContext = stripInternalRuntimeContext(raw);
  if (role === "assistant") {
    return stripAssistantMessageText(projected, withoutInternalContext, "display");
  }
  return shouldStripInboundMetadata
    ? stripUserEnvelopeForDisplay(withoutInternalContext)
    : stripEnvelope(withoutInternalContext);
}

function readCachedMessageExtraction(
  message: unknown,
  cache: WeakMap<object, string | null>,
  extract: (message: unknown) => string | null,
): string | null {
  if (!message || typeof message !== "object") {
    return extract(message);
  }
  if (cache.has(message)) {
    return cache.get(message) ?? null;
  }
  const value = extract(message);
  cache.set(message, value);
  return value;
}

export function extractTextCached(message: unknown): string | null {
  return readCachedMessageExtraction(message, textCache, extractText);
}

function contentText(
  content: unknown,
  read: (item: Record<string, unknown>) => string | undefined,
): string | null {
  const parts = Array.isArray(content)
    ? content.flatMap((value) => {
        const item = asOptionalRecord(value);
        const text = item ? read(item) : undefined;
        return text === undefined ? [] : [text];
      })
    : [];
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractThinking(message: unknown): string | null {
  return contentText((message as Record<string, unknown> | null | undefined)?.content, (item) =>
    item.type === "thinking" && typeof item.thinking === "string"
      ? item.thinking.trim() || undefined
      : undefined,
  );
}

export function extractThinkingCached(message: unknown): string | null {
  return readCachedMessageExtraction(message, thinkingCache, extractThinking);
}

function extractRawText(message: unknown): string | null {
  if (message == null) {
    return null;
  }
  const m = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(m.role);
  const content = m.content;
  if (typeof content === "string") {
    return content;
  }
  return (
    contentText(content, (item) =>
      (item.type === "text" ||
        (role === "user" && item.type === "input_text") ||
        (role === "assistant" && (item.type === "input_text" || item.type === "output_text"))) &&
      typeof item.text === "string"
        ? item.text
        : undefined,
    ) ?? (typeof m.text === "string" ? m.text : null)
  );
}

export function readTranscriptMediaEntries(message: unknown) {
  if (!message || typeof message !== "object") {
    return [];
  }
  return (readPersistedMediaFacts(message) ?? []).flatMap((fact, factIndex) => {
    const path = fact.path ?? fact.url;
    return path
      ? [
          {
            factIndex,
            path,
            mediaType: fact.contentType ?? fact.kind,
            fileName: fact.fileName,
            ...(fact.origin ? { origin: fact.origin } : {}),
            ...(fact.sizeBytes !== undefined ? { sizeBytes: fact.sizeBytes } : {}),
            ...(fact.durationMs !== undefined ? { durationMs: fact.durationMs } : {}),
            ...(fact.width !== undefined ? { width: fact.width } : {}),
            ...(fact.height !== undefined ? { height: fact.height } : {}),
          },
        ]
      : [];
  });
}

/** True for user rows with no text and no media facts; such rows hide from history. */
export function isEmptyUserTextOnlyMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (normalizeLowercaseStringOrEmpty(entry.role) !== "user") {
    return false;
  }
  if (readTranscriptMediaEntries(entry).length > 0) {
    return false;
  }
  const content = entry.content ?? entry.text;
  if (typeof content !== "string") {
    if (!Array.isArray(content)) {
      return false;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        return false;
      }
      const blockEntry = block as { type?: unknown; text?: unknown };
      if (blockEntry.type !== "text" || typeof blockEntry.text !== "string") {
        return false;
      }
    }
  }
  return (extractText(message)?.trim() ?? "") === "";
}
