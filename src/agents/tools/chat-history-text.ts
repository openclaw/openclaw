import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { sanitizeAssistantVisibleTextWithOptions } from "../../shared/text/assistant-visible-text.js";
import { sanitizeUserFacingText } from "../pi-embedded-helpers.js";
import { extractAssistantVisibleText } from "../pi-embedded-utils.js";

export function stripToolMessages(messages: unknown[]): unknown[] {
  return messages.filter((msg) => {
    if (!msg || typeof msg !== "object") {
      return true;
    }
    const role = (msg as { role?: unknown }).role;
    return role !== "toolResult" && role !== "tool";
  });
}

/**
 * Sanitize text content to strip tool call markers and thinking tags.
 * This ensures user-facing text doesn't leak internal tool representations.
 */
export function sanitizeTextContent(text: string): string {
  return sanitizeAssistantVisibleTextWithOptions(text, { trim: "none" });
}

export function hasAssistantPhaseMetadata(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      typeof (block as { textSignature?: unknown }).textSignature === "string",
  );
}

export function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return undefined;
  }
  if (hasAssistantPhaseMetadata(message)) {
    const visibleText = extractAssistantVisibleText(
      message as Parameters<typeof extractAssistantVisibleText>[0],
    );
    return visibleText?.trim() ? visibleText : undefined;
  }
  const content = (message as { content?: unknown }).content;
  const joined = Array.isArray(content)
    ? (extractTextFromChatContent(content, {
        sanitizeText: sanitizeTextContent,
        joinWith: "",
        normalizeText: (text) => text.trim(),
      }) ?? "")
    : sanitizeTextContent(
        extractAssistantVisibleText(message as Parameters<typeof extractAssistantVisibleText>[0]) ??
          "",
      );
  if (!joined.trim()) {
    return undefined;
  }
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  // Gate on stopReason only — a non-error response with a stale/background errorMessage
  // should not have its content rewritten with error templates (#13935).
  const errorContext = stopReason === "error";

  return sanitizeUserFacingText(joined, { errorContext });
}
