function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function resolvePluginWebSearchConfig(config, pluginId) {
    const pluginConfig = config?.plugins?.entries?.[pluginId]?.config;
    if (!isRecord(pluginConfig)) {
        return undefined;
    }
    return isRecord(pluginConfig.webSearch) ? pluginConfig.webSearch : undefined;
}
