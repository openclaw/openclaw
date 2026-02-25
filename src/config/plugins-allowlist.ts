import type { ActiviConfig } from "./config.js";

export function ensurePluginAllowlisted(cfg: ActiviConfig, pluginId: string): ActiviConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.includes(pluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  };
}
