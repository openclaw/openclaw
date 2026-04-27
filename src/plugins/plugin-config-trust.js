import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
export function normalizePluginConfigId(id) {
    return normalizeOptionalLowercaseString(id) ?? "";
}
function hasPluginConfigId(list, pluginId) {
    return Array.isArray(list) && list.some((entry) => normalizePluginConfigId(entry) === pluginId);
}
function findPluginConfigEntry(entries, pluginId) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        return undefined;
    }
    for (const [key, value] of Object.entries(entries)) {
        if (normalizePluginConfigId(key) !== pluginId) {
            continue;
        }
        return value && typeof value === "object" && !Array.isArray(value)
            ? value
            : {};
    }
    return undefined;
}
export function isWorkspacePluginAllowedByConfig(params) {
    const pluginsConfig = params.config?.plugins;
    if (pluginsConfig?.enabled === false) {
        return false;
    }
    const pluginId = normalizePluginConfigId(params.plugin.id);
    if (!pluginId || hasPluginConfigId(pluginsConfig?.deny, pluginId)) {
        return false;
    }
    const entry = findPluginConfigEntry(pluginsConfig?.entries, pluginId);
    if (entry?.enabled === false) {
        return false;
    }
    if (entry?.enabled === true || hasPluginConfigId(pluginsConfig?.allow, pluginId)) {
        return true;
    }
    return params.isImplicitlyAllowed?.(pluginId) ?? false;
}
