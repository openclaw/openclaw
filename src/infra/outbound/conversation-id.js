function normalizeConversationId(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}
export function resolveConversationIdFromTargets(params) {
    const threadId = params.threadId != null ? normalizeConversationId(String(params.threadId)) : undefined;
    if (threadId) {
        return threadId;
    }
    for (const rawTarget of params.targets) {
        const target = normalizeConversationId(rawTarget);
        if (!target) {
            continue;
        }
        if (target.startsWith("channel:")) {
            const channelId = normalizeConversationId(target.slice("channel:".length));
            if (channelId) {
                return channelId;
            }
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
