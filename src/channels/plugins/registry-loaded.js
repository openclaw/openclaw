import { getActivePluginChannelRegistryFromState, getActivePluginChannelRegistryVersionFromState, } from "../../plugins/runtime-channel-state.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CHAT_CHANNEL_ORDER } from "../registry.js";
const EMPTY_CHANNEL_PLUGIN_CACHE = {
    registryVersion: -1,
    registryRef: null,
    sorted: [],
    byId: new Map(),
};
let cachedChannelPlugins = EMPTY_CHANNEL_PLUGIN_CACHE;
function coerceLoadedChannelPlugin(plugin) {
    const id = normalizeOptionalString(plugin?.id) ?? "";
    if (!plugin || !id) {
        return null;
    }
    if (!plugin.meta || typeof plugin.meta !== "object") {
        plugin.meta = {};
    }
    return plugin;
}
function dedupeChannels(channels) {
    const seen = new Set();
    const resolved = [];
    for (const plugin of channels) {
        const id = normalizeOptionalString(plugin.id) ?? "";
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        resolved.push(plugin);
    }
    return resolved;
}
function resolveCachedChannelPlugins() {
    const registry = getActivePluginChannelRegistryFromState();
    const registryVersion = getActivePluginChannelRegistryVersionFromState();
    const cached = cachedChannelPlugins;
    if (cached.registryVersion === registryVersion && cached.registryRef === registry) {
        return cached;
    }
    const channelPlugins = [];
    if (registry && Array.isArray(registry.channels)) {
        for (const entry of registry.channels) {
            const plugin = coerceLoadedChannelPlugin(entry?.plugin);
            if (plugin) {
                channelPlugins.push(plugin);
            }
        }
    }
    const sorted = dedupeChannels(channelPlugins).toSorted((a, b) => {
        const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
        const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
        const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
        const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        return a.id.localeCompare(b.id);
    });
    const byId = new Map();
    for (const plugin of sorted) {
        byId.set(plugin.id, plugin);
    }
    const next = {
        registryVersion,
        registryRef: registry,
        sorted,
        byId,
    };
    cachedChannelPlugins = next;
    return next;
}
export function listLoadedChannelPlugins() {
    return resolveCachedChannelPlugins().sorted.slice();
}
export function getLoadedChannelPluginById(id) {
    const resolvedId = normalizeOptionalString(id) ?? "";
    if (!resolvedId) {
        return undefined;
    }
    return resolveCachedChannelPlugins().byId.get(resolvedId);
}
