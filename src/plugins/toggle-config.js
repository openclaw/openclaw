import { normalizeChatChannelId } from "../channels/ids.js";
export function setPluginEnabledInConfig(config, pluginId, enabled) {
    const builtInChannelId = normalizeChatChannelId(pluginId);
    const resolvedId = builtInChannelId ?? pluginId;
    const next = {
        ...config,
        plugins: {
            ...config.plugins,
            entries: {
                ...config.plugins?.entries,
                [resolvedId]: {
                    ...config.plugins?.entries?.[resolvedId],
                    enabled,
                },
            },
        },
    };
    if (!builtInChannelId) {
        return next;
    }
    const channels = config.channels;
    const existing = channels?.[builtInChannelId];
    const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing
        : {};
    return {
        ...next,
        channels: {
            ...config.channels,
            [builtInChannelId]: {
                ...existingRecord,
                enabled,
            },
        },
    };
}
