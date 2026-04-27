import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
function coerceLoadedChannelPlugin(plugin) {
    const id = normalizeOptionalString(plugin?.id) ?? "";
    if (!plugin || !id) {
        return undefined;
    }
    if (!plugin.meta || typeof plugin.meta !== "object") {
        plugin.meta = {};
    }
    return plugin;
}
export function getLoadedChannelPluginForRead(id) {
    const resolvedId = normalizeOptionalString(id) ?? "";
    if (!resolvedId) {
        return undefined;
    }
    const registry = getActivePluginChannelRegistryFromState();
    if (!registry || !Array.isArray(registry.channels)) {
        return undefined;
    }
    for (const entry of registry.channels) {
        const plugin = coerceLoadedChannelPlugin(entry?.plugin);
        if (plugin && plugin.id === resolvedId) {
            return plugin;
        }
    }
    return undefined;
}
