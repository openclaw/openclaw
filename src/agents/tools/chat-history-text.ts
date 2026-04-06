import { extractTextFromChatContent } from "../../shared/chat-content.js";
import {
  normalizeAssistantPhase,
  parseAssistantTextSignature,
  type AssistantPhase,
} from "../../shared/chat-message-content.js";
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

function extractAssistantTextForPhase(
  message: unknown,
  phase?: AssistantPhase,
): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return undefined;
  }
  const entry = message as { text?: unknown; content?: unknown; phase?: unknown };
  const messagePhase = normalizeAssistantPhase(entry.phase);
  const shouldIncludeContent = (resolvedPhase?: AssistantPhase) => {
    if (phase) {
      return resolvedPhase === phase;
    }
    return resolvedPhase === undefined;
  };
  const normalizeVisibleText = (text: string) => {
    const normalized = sanitizeTextContent(text).trim();
    return normalized || undefined;
  };

  if (typeof entry.text === "string") {
    return shouldIncludeContent(messagePhase) ? normalizeVisibleText(entry.text) : undefined;
  }

  if (typeof entry.content === "string") {
    return shouldIncludeContent(messagePhase) ? normalizeVisibleText(entry.content) : undefined;
  }

  if (!Array.isArray(entry.content)) {
    return undefined;
  }

  const hasExplicitPhasedTextBlocks = entry.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const record = block as { type?: unknown; textSignature?: unknown };
    if (record.type !== "text") {
      return false;
    }
    return Boolean(parseAssistantTextSignature(record.textSignature)?.phase);
  });

  const joined =
    extractTextFromChatContent(
      entry.content.filter((block) => {
        if (!block || typeof block !== "object") {
          return false;
        }
        const record = block as { type?: unknown; textSignature?: unknown };
        if (record.type !== "text") {
          return false;
        }
        const signature = parseAssistantTextSignature(record.textSignature);
        const resolvedPhase =
          signature?.phase ?? (hasExplicitPhasedTextBlocks ? undefined : messagePhase);
        return shouldIncludeContent(resolvedPhase);
      }),
      {
        sanitizeText: sanitizeTextContent,
        joinWith: "",
        normalizeText: (text) => text.trim(),
      },
    ) ?? "";

  return joined || undefined;
}

export function extractAssistantText(message: unknown): string | undefined {
  const joined =
    extractAssistantTextForPhase(message, "final_answer") ?? extractAssistantTextForPhase(message);
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  // Gate on stopReason only — a non-error response with a stale/background errorMessage
  // should not have its content rewritten with error templates (#13935).
  const errorContext = stopReason === "error";

  return joined ? sanitizeUserFacingText(joined, { errorContext }) : undefined;
}
