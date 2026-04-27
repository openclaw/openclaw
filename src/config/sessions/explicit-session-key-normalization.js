import { getLoadedChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, } from "../../shared/string-coerce.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
function resolveExplicitSessionKeyNormalizerCandidates(sessionKey, ctx) {
    const normalizedProvider = normalizeOptionalLowercaseString(ctx.Provider);
    const normalizedSurface = normalizeOptionalLowercaseString(ctx.Surface);
    const normalizedFrom = normalizeLowercaseStringOrEmpty(ctx.From);
    const candidates = new Set();
    const maybeAdd = (value) => {
        const normalized = normalizeMessageChannel(value);
        if (normalized) {
            candidates.add(normalized);
        }
    };
    maybeAdd(normalizedSurface);
    maybeAdd(normalizedProvider);
    maybeAdd(normalizedFrom.split(":", 1)[0]);
    for (const plugin of listChannelPlugins()) {
        const pluginId = normalizeMessageChannel(plugin.id);
        if (!pluginId) {
            continue;
        }
        if (sessionKey.startsWith(`${pluginId}:`) || sessionKey.includes(`:${pluginId}:`)) {
            candidates.add(pluginId);
        }
    }
    return [...candidates];
}
export function normalizeExplicitSessionKey(sessionKey, ctx) {
    const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
    for (const channelId of resolveExplicitSessionKeyNormalizerCandidates(normalized, ctx)) {
        const normalize = getLoadedChannelPlugin(channelId)?.messaging?.normalizeExplicitSessionKey;
        const next = normalize?.({ sessionKey: normalized, ctx });
        if (typeof next === "string" && next.trim()) {
            return normalizeLowercaseStringOrEmpty(next);
        }
    }
    return normalized;
}
