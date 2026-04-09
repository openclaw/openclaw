type PluginWebSearchConfigCarrier = {
  plugins?: {
    entries?: Record<
      string,
      {
        config?: unknown;
      }
    >;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolvePluginWebSearchConfig(
  config: PluginWebSearchConfigCarrier | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const pluginConfig = config?.plugins?.entries?.[pluginId]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  return isRecord(pluginConfig.webSearch) ? pluginConfig.webSearch : undefined;
}
