import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";

export function withFixturePlugin(
  config: OpenClawConfig,
  pluginDir: string,
  pluginId: string,
): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), pluginId])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), pluginDir])],
      },
      entries: {
        ...config.plugins?.entries,
        [pluginId]: { enabled: true },
      },
    },
  };
}
