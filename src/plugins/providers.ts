import { normalizeProviderId } from "../agents/provider-id.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { hasExplicitPluginConfig } from "./config-state.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

function withBundledProviderVitestCompat(params: {
  config: PluginLoadOptions["config"];
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
}): PluginLoadOptions["config"] {
  const env = params.env ?? process.env;
  if (
    !env.VITEST ||
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

function resolveBundledProviderCompatPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: string[];
}): string[] {
  const onlyPluginIdSet = params.onlyPluginIds ? new Set(params.onlyPluginIds) : null;
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return registry.plugins
    .filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        plugin.providers.length > 0 &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export const __testing = {
  resolveBundledProviderCompatPluginIds,
  withBundledProviderVitestCompat,
} as const;

export function resolveOwningPluginIdsForProvider(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }

  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const pluginIds = registry.plugins
    .filter((plugin) =>
      plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedProvider),
    )
    .map((plugin) => plugin.id);

  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveNonBundledProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return registry.plugins
    .filter(
      (plugin) =>
        plugin.origin !== "bundled" &&
        plugin.providers.length > 0 &&
        resolveEffectiveEnableState({
          id: plugin.id,
          origin: plugin.origin,
          config: normalizedConfig,
          rootConfig: params.config,
        }).enabled,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: PluginLoadOptions["env"];
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
  activate?: boolean;
  cache?: boolean;
}): ProviderPlugin[] {
  const bundledProviderCompatPluginIds =
    params.bundledProviderAllowlistCompat || params.bundledProviderVitestCompat
      ? resolveBundledProviderCompatPluginIds({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          onlyPluginIds: params.onlyPluginIds,
        })
      : [];
  const maybeAllowlistCompat = params.bundledProviderAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: bundledProviderCompatPluginIds,
      })
    : params.config;
  const maybeVitestCompat = params.bundledProviderVitestCompat
    ? withBundledProviderVitestCompat({
        config: maybeAllowlistCompat,
        pluginIds: bundledProviderCompatPluginIds,
        env: params.env,
      })
    : maybeAllowlistCompat;
  const config =
    params.bundledProviderAllowlistCompat || params.bundledProviderVitestCompat
      ? withBundledPluginEnablementCompat({
          config: maybeVitestCompat,
          pluginIds: bundledProviderCompatPluginIds,
        })
      : maybeVitestCompat;
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    cache: params.cache ?? false,
    activate: params.activate ?? false,
    logger: createPluginLoaderLogger(log),
  });

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
