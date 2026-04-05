import type { MullusiConfig } from "./config.js";

export function ensurePluginAllowlisted(cfg: MullusiConfig, pluginId: string): MullusiConfig {
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
