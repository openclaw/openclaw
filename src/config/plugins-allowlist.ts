import type { BotConfig } from "./config.js";

export function ensurePluginAllowlisted(cfg: BotConfig, pluginId: string): BotConfig {
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
