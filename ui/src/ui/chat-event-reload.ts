// Control UI module implements chat event reload behavior.
import { extractText, extractThinking } from "./chat/message-extract.ts";
import type { ChatEventPayload } from "./controllers/chat.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

function hasRenderableAssistantFinalMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role && role !== "assistant") {
    return false;
  }
  if (!("content" in entry) && !("text" in entry)) {
    return false;
  }
  const text = extractText(message);
  return typeof text === "string" && text.trim() !== "" && !SILENT_REPLY_PATTERN.test(text);
}

function hasThinkingBlock(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && extractThinking(message));
}

export function shouldReloadHistoryForFinalEvent(
  payload?: ChatEventPayload,
  opts: { deferredSessionMessageHasThinking?: boolean } = {},
): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  if (opts.deferredSessionMessageHasThinking === true && !hasThinkingBlock(payload.message)) {
    return true;
  }
  return !hasRenderableAssistantFinalMessage(payload.message);
}
