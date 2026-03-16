import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import type { WebSearchProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

const BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS = [
  "brave",
  "google",
  "moonshot",
  "perplexity",
  "xai",
] as const;

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): WebSearchProviderPlugin[] {
  const allowlistCompat = params.bundledAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS,
      })
    : params.config;
  const config = withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds: BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS,
  });
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    logger: createPluginLoaderLogger(log),
    activate: false,
    cache: false,
    onlyPluginIds: [...BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS],
  });

  return registry.webSearchProviders
    .map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    }))
    .toSorted((a, b) => {
      const aOrder = a.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      return a.id.localeCompare(b.id);
    });
}
