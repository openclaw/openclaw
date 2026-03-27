import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import {
  resolveEnabledProviderPluginIds,
  resolveBundledProviderCompatPluginIds,
  withBundledProviderVitestCompat,
} from "./providers.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

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
  pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"];
}): ProviderPlugin[] {
  const env = params.env ?? process.env;
  const autoEnabledConfig =
    params.config !== undefined
      ? applyPluginAutoEnable({
          config: params.config,
          env,
        }).config
      : undefined;
  const bundledProviderCompatPluginIds =
    params.bundledProviderAllowlistCompat || params.bundledProviderVitestCompat
      ? resolveBundledProviderCompatPluginIds({
          config: autoEnabledConfig,
          workspaceDir: params.workspaceDir,
          env,
          onlyPluginIds: params.onlyPluginIds,
        })
      : [];
  const maybeAllowlistCompat = params.bundledProviderAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: autoEnabledConfig,
        pluginIds: bundledProviderCompatPluginIds,
      })
    : autoEnabledConfig;
  const allowlistCompatConfig = params.bundledProviderAllowlistCompat
    ? withBundledPluginEnablementCompat({
        config: maybeAllowlistCompat,
        pluginIds: bundledProviderCompatPluginIds,
      })
    : maybeAllowlistCompat;
  const config = params.bundledProviderVitestCompat
    ? withBundledProviderVitestCompat({
        config: allowlistCompatConfig,
        pluginIds: bundledProviderCompatPluginIds,
        env,
      })
    : allowlistCompatConfig;
  const providerPluginIds = resolveEnabledProviderPluginIds({
    config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: params.onlyPluginIds,
  });
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: providerPluginIds,
    pluginSdkResolution: params.pluginSdkResolution,
    cache: params.cache ?? false,
    activate: params.activate ?? false,
    providerOnly: !(params.activate ?? false),
    logger: createPluginLoaderLogger(log),
  });

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
