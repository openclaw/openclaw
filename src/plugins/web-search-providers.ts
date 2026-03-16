import type { PluginEntryConfig } from "../config/types.plugins.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
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

function withBundledWebSearchAllowlistCompat(
  config: PluginLoadOptions["config"],
): PluginLoadOptions["config"] {
  const allow = config?.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return config;
  }

  const allowSet = new Set(allow.map((entry) => entry.trim()).filter(Boolean));
  let changed = false;
  for (const pluginId of BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS) {
    if (!allowSet.has(pluginId)) {
      allowSet.add(pluginId);
      changed = true;
    }
  }

  if (!changed) {
    return config;
  }

  return {
    ...config,
    plugins: {
      ...config?.plugins,
      allow: [...allowSet],
    },
  };
}

function withBundledWebSearchEnablementCompat(
  config: PluginLoadOptions["config"],
): PluginLoadOptions["config"] {
  const existingEntries = config?.plugins?.entries ?? {};
  let changed = false;
  const nextEntries: Record<string, PluginEntryConfig> = { ...existingEntries };

  for (const pluginId of BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS) {
    if (existingEntries[pluginId] !== undefined) {
      continue;
    }
    nextEntries[pluginId] = { enabled: true };
    changed = true;
  }

  if (!changed) {
    return config;
  }

  return {
    ...config,
    plugins: {
      ...config?.plugins,
      entries: {
        ...existingEntries,
        ...nextEntries,
      },
    },
  };
}

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): WebSearchProviderPlugin[] {
  const allowlistCompat = params.bundledAllowlistCompat
    ? withBundledWebSearchAllowlistCompat(params.config)
    : params.config;
  const config = withBundledWebSearchEnablementCompat(allowlistCompat);
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
