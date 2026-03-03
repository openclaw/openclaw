import { normalizeChatType } from "../channels/chat-type.js";
function normalizeDecision(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "allow") {
        return "allow";
    }
    if (normalized === "deny") {
        return "deny";
    }
    return undefined;
}
function normalizeMatch(value) {
    const normalized = value?.trim().toLowerCase();
    return normalized || undefined;
}
export function normalizeMediaUnderstandingChatType(raw) {
    return normalizeChatType(raw ?? undefined);
}
export function resolveMediaUnderstandingScope(params) {
    const scope = params.scope;
    if (!scope) {
        return "allow";
    }
    const channel = normalizeMatch(params.channel);
    const chatType = normalizeMediaUnderstandingChatType(params.chatType);
    const sessionKey = normalizeMatch(params.sessionKey) ?? "";
    for (const rule of scope.rules ?? []) {
        if (!rule) {
            continue;
        }
        const action = normalizeDecision(rule.action) ?? "allow";
        const match = rule.match ?? {};
        const matchChannel = normalizeMatch(match.channel);
        const matchChatType = normalizeMediaUnderstandingChatType(match.chatType);
        const matchPrefix = normalizeMatch(match.keyPrefix);
        if (matchChannel && matchChannel !== channel) {
            continue;
        }
        if (matchChatType && matchChatType !== chatType) {
            continue;
        }
        if (matchPrefix && !sessionKey.startsWith(matchPrefix)) {
            continue;
        }
        return action;
    }
    return normalizeDecision(scope.default) ?? "allow";
}
