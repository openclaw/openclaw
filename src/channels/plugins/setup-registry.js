import { getActivePluginChannelRegistry, getActivePluginRegistryVersion, requireActivePluginRegistry, } from "../../plugins/runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CHAT_CHANNEL_ORDER } from "../registry.js";
import { listBundledChannelSetupPlugins } from "./bundled.js";
const EMPTY_CHANNEL_SETUP_CACHE = {
    registryVersion: -1,
    registryRef: null,
    sorted: [],
    byId: new Map(),
};
let cachedChannelSetupPlugins = EMPTY_CHANNEL_SETUP_CACHE;
function dedupeSetupPlugins(plugins) {
    const seen = new Set();
    const resolved = [];
    for (const plugin of plugins) {
        const id = normalizeOptionalString(plugin.id) ?? "";
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        resolved.push(plugin);
    }
    return resolved;
}
function sortChannelSetupPlugins(plugins) {
    return dedupeSetupPlugins(plugins).toSorted((a, b) => {
        const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
        const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
        const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
        const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        return a.id.localeCompare(b.id);
    });
}
function resolveCachedChannelSetupPlugins() {
    const registry = requireActivePluginRegistry();
    const registryVersion = getActivePluginRegistryVersion();
    const cached = cachedChannelSetupPlugins;
    if (cached.registryVersion === registryVersion && cached.registryRef === registry) {
        return cached;
    }
    const registryPlugins = (registry.channelSetups ?? []).map((entry) => entry.plugin);
    const sorted = sortChannelSetupPlugins(registryPlugins.length > 0 ? registryPlugins : listBundledChannelSetupPlugins());
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
    cachedChannelSetupPlugins = next;
    return next;
}
export function listChannelSetupPlugins() {
    return resolveCachedChannelSetupPlugins().sorted.slice();
}
export function listActiveChannelSetupPlugins() {
    const registry = getActivePluginChannelRegistry();
    return sortChannelSetupPlugins((registry?.channelSetups ?? []).map((entry) => entry.plugin));
}
export function getChannelSetupPlugin(id) {
    const resolvedId = normalizeOptionalString(id) ?? "";
    if (!resolvedId) {
        return undefined;
    }
    return resolveCachedChannelSetupPlugins().byId.get(resolvedId);
}
