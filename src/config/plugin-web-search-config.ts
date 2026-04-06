import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./config.js";

export function resolvePluginWebSearchConfig(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const pluginConfig = config?.plugins?.entries?.[pluginId]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  return isRecord(pluginConfig.webSearch) ? pluginConfig.webSearch : undefined;
}
