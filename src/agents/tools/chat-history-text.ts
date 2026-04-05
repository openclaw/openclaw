import { sanitizeUserFacingText } from "../pi-embedded-helpers.js";
import {
  stripDowngradedToolCallText,
  stripMinimaxToolCallXml,
  stripModelSpecialTokens,
  stripThinkingTagsFromText,
} from "../pi-embedded-utils.js";

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
  if (!text) {
    return text;
  }
  return stripThinkingTagsFromText(
    stripDowngradedToolCallText(stripModelSpecialTokens(stripMinimaxToolCallXml(text))),
  );
}

export function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const joined =
    extractTextFromChatContent(content, {
      sanitizeText: sanitizeTextContent,
      joinWith: "",
      normalizeText: (text) => text.trim(),
    }) ?? "";
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  // Gate on stopReason only — a non-error response with a stale/background errorMessage
  // should not have its content rewritten with error templates (#13935).
  const errorContext = stopReason === "error";

  return joined ? sanitizeUserFacingText(joined, { errorContext }) : undefined;
}
