import { parseRawSessionConversationRef, parseThreadSessionSuffix, } from "../../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded-read.js";
function resolveLoadedSessionConversationThreadInfo(sessionKey) {
    const raw = parseRawSessionConversationRef(sessionKey);
    if (!raw) {
        return null;
    }
    const rawId = raw.rawId.trim();
    if (!rawId) {
        return null;
    }
    const messaging = getLoadedChannelPluginForRead(raw.channel)?.messaging;
    const resolved = messaging?.resolveSessionConversation?.({
        kind: raw.kind,
        rawId,
    });
    if (!resolved?.id?.trim()) {
        return null;
    }
    const id = resolved.id.trim();
    const threadId = normalizeOptionalString(resolved.threadId);
    return {
        baseSessionKey: threadId ? `${raw.prefix}:${id}` : normalizeOptionalString(sessionKey),
        threadId,
    };
}
export function resolveLoadedSessionThreadInfo(sessionKey) {
    return (resolveLoadedSessionConversationThreadInfo(sessionKey) ?? parseThreadSessionSuffix(sessionKey));
}
