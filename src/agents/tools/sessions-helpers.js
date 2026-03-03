export { createAgentToAgentPolicy, createSessionVisibilityGuard, resolveEffectiveSessionToolsVisibility, resolveSandboxSessionToolsVisibility, resolveSandboxedSessionToolContext, resolveSessionToolsVisibility, } from "./sessions-access.js";
export { isRequesterSpawnedSessionVisible, isResolvedSessionVisibleToRequester, listSpawnedSessionKeys, looksLikeSessionId, looksLikeSessionKey, resolveDisplaySessionKey, resolveInternalSessionKey, resolveMainSessionAlias, resolveSessionReference, shouldResolveSessionIdInput, shouldVerifyRequesterSpawnedSessionVisibility, } from "./sessions-resolution.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { sanitizeUserFacingText } from "../pi-embedded-helpers.js";
import { stripDowngradedToolCallText, stripMinimaxToolCallXml, stripThinkingTagsFromText, } from "../pi-embedded-utils.js";
function normalizeKey(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
export function classifySessionKind(params) {
    const key = params.key;
    if (key === params.alias || key === params.mainKey) {
        return "main";
    }
    if (key.startsWith("cron:")) {
        return "cron";
    }
    if (key.startsWith("hook:")) {
        return "hook";
    }
    if (key.startsWith("node-") || key.startsWith("node:")) {
        return "node";
    }
    if (params.gatewayKind === "group") {
        return "group";
    }
    if (key.includes(":group:") || key.includes(":channel:")) {
        return "group";
    }
    return "other";
}
export function deriveChannel(params) {
    if (params.kind === "cron" || params.kind === "hook" || params.kind === "node") {
        return "internal";
    }
    const channel = normalizeKey(params.channel ?? undefined);
    if (channel) {
        return channel;
    }
    const lastChannel = normalizeKey(params.lastChannel ?? undefined);
    if (lastChannel) {
        return lastChannel;
    }
    const parts = params.key.split(":").filter(Boolean);
    if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
        return parts[0];
    }
    return "unknown";
}
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
    if (!text) {
        return text;
    }
    return stripThinkingTagsFromText(stripDowngradedToolCallText(stripMinimaxToolCallXml(text)));
}
export function extractAssistantText(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    if (message.role !== "assistant") {
        return undefined;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return undefined;
    }
    const joined = extractTextFromChatContent(content, {
        sanitizeText: sanitizeTextContent,
        joinWith: "",
        normalizeText: (text) => text.trim(),
    }) ?? "";
    const stopReason = message.stopReason;
    const errorMessage = message.errorMessage;
    const errorContext = stopReason === "error" || (typeof errorMessage === "string" && Boolean(errorMessage.trim()));
    return joined ? sanitizeUserFacingText(joined, { errorContext }) : undefined;
}
