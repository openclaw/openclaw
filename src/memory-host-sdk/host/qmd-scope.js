import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, } from "../../shared/string-coerce.js";
export function isQmdScopeAllowed(scope, sessionKey) {
    if (!scope) {
        return true;
    }
    const parsed = parseQmdSessionScope(sessionKey);
    const channel = parsed.channel;
    const chatType = parsed.chatType;
    const normalizedKey = parsed.normalizedKey ?? "";
    const rawKey = normalizeLowercaseStringOrEmpty(sessionKey);
    for (const rule of scope.rules ?? []) {
        if (!rule) {
            continue;
        }
        const match = rule.match ?? {};
        if (match.channel && match.channel !== channel) {
            continue;
        }
        if (match.chatType && match.chatType !== chatType) {
            continue;
        }
        const normalizedPrefix = normalizeOptionalLowercaseString(match.keyPrefix);
        const rawPrefix = normalizeOptionalLowercaseString(match.rawKeyPrefix);
        if (rawPrefix && !rawKey.startsWith(rawPrefix)) {
            continue;
        }
        if (normalizedPrefix) {
            // Backward compat: older configs used `keyPrefix: "agent:<id>:..."` to match raw keys.
            const isLegacyRaw = normalizedPrefix.startsWith("agent:");
            if (isLegacyRaw) {
                if (!rawKey.startsWith(normalizedPrefix)) {
                    continue;
                }
            }
            else if (!normalizedKey.startsWith(normalizedPrefix)) {
                continue;
            }
        }
        return rule.action === "allow";
    }
    const fallback = scope.default ?? "allow";
    return fallback === "allow";
}
export function deriveQmdScopeChannel(key) {
    return parseQmdSessionScope(key).channel;
}
export function deriveQmdScopeChatType(key) {
    return parseQmdSessionScope(key).chatType;
}
function parseQmdSessionScope(key) {
    const normalized = normalizeQmdSessionKey(key);
    if (!normalized) {
        return {};
    }
    const parts = normalized.split(":").filter(Boolean);
    let chatType;
    if (parts.length >= 2 &&
        (parts[1] === "group" || parts[1] === "channel" || parts[1] === "direct" || parts[1] === "dm")) {
        if (parts.includes("group")) {
            chatType = "group";
        }
        else if (parts.includes("channel")) {
            chatType = "channel";
        }
        return {
            normalizedKey: normalized,
            channel: normalizeOptionalLowercaseString(parts[0]),
            chatType: chatType ?? "direct",
        };
    }
    if (normalized.includes(":group:")) {
        return { normalizedKey: normalized, chatType: "group" };
    }
    if (normalized.includes(":channel:")) {
        return { normalizedKey: normalized, chatType: "channel" };
    }
    return { normalizedKey: normalized, chatType: "direct" };
}
function normalizeQmdSessionKey(key) {
    if (!key) {
        return undefined;
    }
    const trimmed = key.trim();
    if (!trimmed) {
        return undefined;
    }
    const parsed = parseAgentSessionKey(trimmed);
    const normalized = normalizeLowercaseStringOrEmpty(parsed?.rest ?? trimmed);
    if (normalized.startsWith("subagent:")) {
        return undefined;
    }
    return normalized;
}
