import type { OpenClawConfig } from "../config/types.js";

export { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";

/**
 * Requires a resolved runtime config at plugin runtime boundaries.
 *
 * @param config Resolved config passed through the current command/gateway path.
 * @param context Human-readable caller context included in the thrown setup error.
 */
export function requireRuntimeConfig(config: OpenClawConfig, context: string): OpenClawConfig {
  if (config) {
    return config;
  }
  throw new Error(
    `${context} requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.`,
  );
}

/**
 * Resolves a plugin's config object from the normalized plugins.entries map.
 *
 * @param config Resolved OpenClaw config; missing config returns undefined for optional callers.
 * @param pluginId Canonical plugin id used as the plugins.entries key.
 */
export function resolvePluginConfigObject(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const plugins =
    config?.plugins && typeof config.plugins === "object" && !Array.isArray(config.plugins)
      ? (config.plugins as Record<string, unknown>)
      : undefined;
  const entries =
    plugins?.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries)
      ? (plugins.entries as Record<string, unknown>)
      : undefined;
  const entry = entries?.[pluginId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const pluginConfig = (entry as { config?: unknown }).config;
  // Plugin config must remain an object here; scalar config is ignored instead of flowing into
  // plugin runtime code as a misleading empty config.
  return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
    ? (pluginConfig as Record<string, unknown>)
    : undefined;
}

/**
 * Resolves live plugin config when a runtime loader exists, otherwise falls back to startup config.
 *
 * @param runtimeConfigLoader Live config supplier installed by long-running plugin runtimes.
 * @param pluginId Canonical plugin id used as the plugins.entries key.
 * @param startupPluginConfig Config snapshot captured before live reload became available.
 */
export function resolveLivePluginConfigObject(
  runtimeConfigLoader: (() => OpenClawConfig | undefined) | undefined,
  pluginId: string,
  startupPluginConfig?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof runtimeConfigLoader !== "function") {
    return startupPluginConfig;
  }
  // Once a live loader is available, do not fall back to startup config; a missing runtime
  // plugin entry means the plugin was removed or disabled after startup.
  return resolvePluginConfigObject(runtimeConfigLoader(), pluginId);
}
