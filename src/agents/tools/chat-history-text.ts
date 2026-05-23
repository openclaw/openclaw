import { extractAssistantTextForPhase } from "../../shared/chat-message-content.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../../shared/text/assistant-visible-text.js";
import { sanitizeUserFacingText } from "../embedded-agent-helpers/sanitize-user-facing-text.js";

const TRANSCRIPT_ONLY_OPENCLAW_MODELS = new Set(["delivery-mirror", "gateway-injected"]);

/**
 * Filter out OpenClaw-internal delivery-mirror and gateway-injected assistant messages.
 * These are transcript-only entries used for delivery tracking; they duplicate real
 * assistant turns and must not be surfaced in sessions_history results.
 */
export function stripTranscriptOnlyMessages(messages: unknown[]): unknown[] {
  return messages.filter((msg) => {
    if (!msg || typeof msg !== "object") {
      return true;
    }
    const entry = msg as Record<string, unknown>;
    if (entry.role !== "assistant") {
      return true;
    }
    const provider = typeof entry.provider === "string" ? entry.provider : "";
    const model = typeof entry.model === "string" ? entry.model : "";
    return !(provider === "openclaw" && TRANSCRIPT_ONLY_OPENCLAW_MODELS.has(model));
  });
}

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
  return sanitizeAssistantVisibleTextWithProfile(text, "history");
}

export function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return undefined;
  }
  const joined =
    extractAssistantTextForPhase(message, {
      phase: "final_answer",
      sanitizeText: sanitizeTextContent,
      joinWith: "",
    }) ??
    extractAssistantTextForPhase(message, {
      sanitizeText: sanitizeTextContent,
      joinWith: "",
    });
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  // Gate on stopReason only — a non-error response with a stale/background errorMessage
  // should not have its content rewritten with error templates (#13935).
  const errorContext = stopReason === "error";

  return joined ? sanitizeUserFacingText(joined, { errorContext }) : undefined;
}
