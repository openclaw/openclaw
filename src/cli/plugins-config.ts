import type { ActiviConfig } from "../config/config.js";

export function setPluginEnabledInConfig(
  config: ActiviConfig,
  pluginId: string,
  enabled: boolean,
): ActiviConfig {
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
