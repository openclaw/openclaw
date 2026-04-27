import { extractAssistantTextForPhase } from "../../shared/chat-message-content.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../../shared/text/assistant-visible-text.js";
import { sanitizeUserFacingText } from "../pi-embedded-helpers/sanitize-user-facing-text.js";
export function stripToolMessages(messages) {
    return messages.filter((msg) => {
        if (!msg || typeof msg !== "object") {
            return true;
        }
        const role = msg.role;
        return role !== "toolResult" && role !== "tool";
    });
}
/**
 * Sanitize text content to strip tool call markers and thinking tags.
 * This ensures user-facing text doesn't leak internal tool representations.
 */
export function sanitizeTextContent(text) {
    return sanitizeAssistantVisibleTextWithProfile(text, "history");
}
export function hasAssistantPhaseMetadata(message) {
    if (!message || typeof message !== "object") {
        return false;
    }
    if (message.role !== "assistant") {
        return false;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return false;
    }
    return content.some((block) => block &&
        typeof block === "object" &&
        typeof block.textSignature === "string");
}
export function extractAssistantText(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    if (message.role !== "assistant") {
        return undefined;
    }
    const joined = extractAssistantTextForPhase(message, {
        phase: "final_answer",
        sanitizeText: sanitizeTextContent,
        joinWith: "",
    }) ??
        extractAssistantTextForPhase(message, {
            sanitizeText: sanitizeTextContent,
            joinWith: "",
        });
    const stopReason = message.stopReason;
    // Gate on stopReason only — a non-error response with a stale/background errorMessage
    // should not have its content rewritten with error templates (#13935).
    const errorContext = stopReason === "error";
    return joined ? sanitizeUserFacingText(joined, { errorContext }) : undefined;
}
