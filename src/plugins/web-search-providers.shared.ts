import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { resolveBundledWebSearchPluginIds } from "./bundled-web-search.js";
import {
  hasExplicitPluginConfig,
  normalizePluginsConfig,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

function resolveBundledWebSearchCompatPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveBundledWebSearchPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}

function withBundledWebSearchVitestCompat(params: {
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

export function sortWebSearchProviders(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return providers.toSorted((a, b) => {
    const aOrder = a.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return a.id.localeCompare(b.id);
  });
}

export function resolveBundledWebSearchResolutionConfig(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): {
  config: PluginLoadOptions["config"];
  normalized: NormalizedPluginsConfig;
} {
  const bundledCompatPluginIds = resolveBundledWebSearchCompatPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const allowlistCompat = params.bundledAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: bundledCompatPluginIds,
      })
    : params.config;
  const enablementCompat = withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds: bundledCompatPluginIds,
  });
  const config = withBundledWebSearchVitestCompat({
    config: enablementCompat,
    pluginIds: bundledCompatPluginIds,
    env: params.env,
  });

  return {
    config,
    normalized: normalizePluginsConfig(config?.plugins),
  };
}
