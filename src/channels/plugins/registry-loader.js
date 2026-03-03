import { getActivePluginRegistry } from "../../plugins/runtime.js";
export function createChannelRegistryLoader(resolveValue) {
    const cache = new Map();
    let lastRegistry = null;
    return async (id) => {
        const registry = getActivePluginRegistry();
        if (registry !== lastRegistry) {
            cache.clear();
            lastRegistry = registry;
        }
        const cached = cache.get(id);
        if (cached) {
            return cached;
        }
        const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
        if (!pluginEntry) {
            return undefined;
        }
        const resolved = resolveValue(pluginEntry);
        if (resolved) {
            cache.set(id, resolved);
        }
        return resolved;
    };
}
