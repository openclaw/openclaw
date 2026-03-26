import type { PluginEntryConfig } from "../config/types.plugins.js";
import { hasExplicitPluginConfig } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";

export function withBundledPluginAllowlistCompat(params: {
  config: PluginLoadOptions["config"];
  pluginIds: readonly string[];
}): PluginLoadOptions["config"] {
  const allow = params.config?.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return params.config;
  }

  const allowSet = new Set(allow.map((entry) => entry.trim()).filter(Boolean));
  let changed = false;
  for (const pluginId of params.pluginIds) {
    if (!allowSet.has(pluginId)) {
      allowSet.add(pluginId);
      changed = true;
    }
  }

  if (!changed) {
    return params.config;
  }

  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      allow: [...allowSet],
    },
  };
}

export function withBundledPluginEnablementCompat(params: {
  config: PluginLoadOptions["config"];
  pluginIds: readonly string[];
}): PluginLoadOptions["config"] {
  const existingEntries = params.config?.plugins?.entries ?? {};
  let changed = false;
  const nextEntries: Record<string, PluginEntryConfig> = { ...existingEntries };

  for (const pluginId of params.pluginIds) {
    if (existingEntries[pluginId] !== undefined) {
      continue;
    }
    nextEntries[pluginId] = { enabled: true };
    changed = true;
  }

  if (!changed) {
    return params.config;
  }

  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      entries: {
        ...existingEntries,
        ...nextEntries,
      },
    },
  };
}

export function withBundledPluginVitestCompat(params: {
  config: PluginLoadOptions["config"];
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
}): PluginLoadOptions["config"] {
  const env = params.env ?? process.env;
  const isVitest = Boolean(env.VITEST || process.env.VITEST);
  if (
    !isVitest ||
    hasExplicitPluginConfig(params.config?.plugins) ||
    params.pluginIds.length === 0
  ) {
    return params.config;
  }

  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      enabled: true,
      allow: [...params.pluginIds],
      slots: {
        ...params.config?.plugins?.slots,
        memory: "none",
      },
    },
  };
}
