import type { OpenClawConfig } from "../config/config.js";

export function setPluginEnabledInConfig(
  config: OpenClawConfig,
  pluginId: string,
  enabled: boolean,
): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [pluginId]: {
          ...(config.plugins?.entries?.[pluginId] as object | undefined),
          enabled,
        },
      },
    },
  };
}
