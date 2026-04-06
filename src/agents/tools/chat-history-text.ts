import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { sanitizeUserFacingText } from "../pi-embedded-helpers.js";
import {
  extractAssistantVisibleText,
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
  const hasPhaseMetadata = content.some(
    (block) =>
      block && typeof block === "object" && typeof (block as { textSignature?: unknown }).textSignature === "string",
  );
  const joined = hasPhaseMetadata
    ? (extractAssistantVisibleText(message as Parameters<typeof extractAssistantVisibleText>[0]) ?? "")
    : (
        extractTextFromChatContent(content, {
          sanitizeText: sanitizeTextContent,
          joinWith: "",
          normalizeText: (text) => text.trim(),
        }) ?? ""
      );
  if (!joined.trim()) {
    return undefined;
  }
  if (hasPhaseMetadata) {
    return joined;
  }
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  // Gate on stopReason only — a non-error response with a stale/background errorMessage
  // should not have its content rewritten with error templates (#13935).
  const errorContext = stopReason === "error";

  return sanitizeUserFacingText(joined, { errorContext });
}
