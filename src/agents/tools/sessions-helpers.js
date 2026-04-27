export { createAgentToAgentPolicy, createSessionVisibilityGuard, resolveEffectiveSessionToolsVisibility, resolveSandboxSessionToolsVisibility, resolveSandboxedSessionToolContext, resolveSessionToolsVisibility, } from "./sessions-access.js";
import { resolveSandboxedSessionToolContext } from "./sessions-access.js";
export { isRequesterSpawnedSessionVisible, isResolvedSessionVisibleToRequester, listSpawnedSessionKeys, looksLikeSessionId, looksLikeSessionKey, resolveDisplaySessionKey, resolveInternalSessionKey, resolveMainSessionAlias, resolveSessionReference, resolveVisibleSessionReference, shouldResolveSessionIdInput, shouldVerifyRequesterSpawnedSessionVisibility, } from "./sessions-resolution.js";
export { extractAssistantText, sanitizeTextContent, stripToolMessages, } from "./chat-history-text.js";
import { loadConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
export function resolveSessionToolContext(opts) {
    const cfg = opts?.config ?? loadConfig();
    return {
        cfg,
        ...resolveSandboxedSessionToolContext({
            cfg,
            agentSessionKey: opts?.agentSessionKey,
            sandboxed: opts?.sandboxed,
        }),
    };
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
    const channel = normalizeOptionalString(params.channel ?? undefined);
    if (channel) {
        return channel;
    }
    const lastChannel = normalizeOptionalString(params.lastChannel ?? undefined);
    if (lastChannel) {
        return lastChannel;
    }
    const parts = params.key.split(":").filter(Boolean);
    if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
        return parts[0];
    }
    return "unknown";
}
