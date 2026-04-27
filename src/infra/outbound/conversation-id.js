import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../../shared/string-coerce.js";
function resolveExplicitConversationTargetId(target) {
    for (const prefix of ["channel:", "conversation:", "group:", "room:", "dm:"]) {
        if (normalizeLowercaseStringOrEmpty(target).startsWith(prefix)) {
            return normalizeOptionalString(target.slice(prefix.length));
        }
    }
    return undefined;
}
export function resolveConversationIdFromTargets(params) {
    const threadId = params.threadId != null ? normalizeOptionalString(String(params.threadId)) : undefined;
    if (threadId) {
        return threadId;
    }
    for (const rawTarget of params.targets) {
        const target = normalizeOptionalString(rawTarget);
        if (!target) {
            continue;
        }
        const explicitConversationId = resolveExplicitConversationTargetId(target);
        if (explicitConversationId) {
            return explicitConversationId;
        }
        if (target.includes(":") && explicitConversationId === undefined) {
            continue;
        }
        const mentionMatch = target.match(/^<#(\d+)>$/);
        if (mentionMatch?.[1]) {
            return mentionMatch[1];
        }
        if (/^\d{6,}$/.test(target)) {
            return target;
        }
    }
    return undefined;
}
