// Control UI module implements chat event reload behavior.
import { extractText } from "../../ui/chat/message-extract.ts";
import { normalizeLowercaseStringOrEmpty } from "../../ui/string-coerce.ts";
import type { ChatEventPayload } from "./gateway.ts";

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

export function shouldReloadHistoryForFinalEvent(payload?: ChatEventPayload): boolean {
  return Boolean(
    payload && payload.state === "final" && !hasRenderableAssistantFinalMessage(payload.message),
  );
}
