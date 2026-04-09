import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/config.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";

export type PluginEnableResult = {
  config: OpenClawConfig;
  enabled: boolean;
  reason?: string;
};

/** Look up an existing plugin entry key by its npm resolvedName (from plugins.installs). */
function findEntryKeyByNpmResolvedName(
  cfg: OpenClawConfig,
  npmResolvedName: string,
): string | undefined {
  const installs = cfg.plugins?.installs ?? {};
  for (const [key, record] of Object.entries(installs)) {
    if (
      record?.source === "npm" &&
      (record.resolvedName?.trim() === npmResolvedName ||
        record.resolvedSpec?.replace(/^npm:/, "").split("@").pop() === npmResolvedName)
    ) {
      return key;
    }
  }
  return undefined;
}

export function enablePluginInConfig(cfg: OpenClawConfig, pluginId: string): PluginEnableResult {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  const resolvedId = builtInChannelId ?? pluginId;
  if (cfg.plugins?.enabled === false) {
    return { config: cfg, enabled: false, reason: "plugins disabled" };
  }
  if (cfg.plugins?.deny?.includes(pluginId) || cfg.plugins?.deny?.includes(resolvedId)) {
    return { config: cfg, enabled: false, reason: "blocked by denylist" };
  }

  // When a marketplace plugin reinstalls with --force, the pluginId may differ from the key
  // the user has in plugins.entries (e.g. manifest id vs npm package name). Preserve the
  // user's existing entry config by looking up the entry by npm resolvedName first.
  let effectivePluginId = resolvedId;
  if (!cfg.plugins?.entries?.[resolvedId]) {
    const npmResolvedName =
      cfg.plugins?.installs?.[resolvedId]?.resolvedName?.trim() ?? resolvedId.replace(/^npm:/, "");
    const existingKey = findEntryKeyByNpmResolvedName(cfg, npmResolvedName);
    if (existingKey) {
      effectivePluginId = existingKey;
    }
  }

  let next = setPluginEnabledInConfig(cfg, effectivePluginId, true);
  next = ensurePluginAllowlisted(next, effectivePluginId);
  return { config: next, enabled: true };
}
