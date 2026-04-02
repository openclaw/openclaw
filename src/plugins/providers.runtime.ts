import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import {
  resolveEnabledProviderPluginIds,
  resolveBundledProviderCompatPluginIds,
  withBundledProviderVitestCompat,
} from "./providers.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

const doctorDebugEnabled = () => process.env.OPENCLAW_DEBUG_DOCTOR === "1";

function debugDoctor(message: string): void {
  if (!doctorDebugEnabled()) {
    return;
  }
  console.error(`[doctor-debug] ${message}`);
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
  pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"];
}): ProviderPlugin[] {
  const env = params.env ?? process.env;
  debugDoctor("providers.runtime:applyPluginAutoEnable:start");
  const autoEnabled =
    params.config !== undefined
      ? applyPluginAutoEnable({
          config: params.config,
          env,
        })
      : undefined;
  debugDoctor("providers.runtime:applyPluginAutoEnable:done");
  const autoEnabledConfig = autoEnabled?.config;
  debugDoctor("providers.runtime:resolveBundledProviderCompatPluginIds:start");
  const bundledProviderCompatPluginIds =
    params.bundledProviderAllowlistCompat || params.bundledProviderVitestCompat
      ? resolveBundledProviderCompatPluginIds({
          config: autoEnabledConfig,
          workspaceDir: params.workspaceDir,
          env,
          onlyPluginIds: params.onlyPluginIds,
        })
      : [];
  debugDoctor("providers.runtime:resolveBundledProviderCompatPluginIds:done");
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
  debugDoctor("providers.runtime:resolveEnabledProviderPluginIds:start");
  const providerPluginIds = resolveEnabledProviderPluginIds({
    config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: params.onlyPluginIds,
  });
  debugDoctor("providers.runtime:resolveEnabledProviderPluginIds:done");
  debugDoctor("providers.runtime:loadOpenClawPlugins:start");
  const registry = resolveRuntimePluginRegistry({
    config,
    activationSourceConfig: params.config,
    autoEnabledReasons: autoEnabled?.autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: providerPluginIds,
    pluginSdkResolution: params.pluginSdkResolution,
    cache: params.cache ?? false,
    activate: params.activate ?? false,
    logger: createPluginLoaderLogger(log),
  });
  if (!registry) {
    return [];
  }

  debugDoctor("providers.runtime:loadOpenClawPlugins:done");
  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
