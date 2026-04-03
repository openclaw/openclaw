import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolvePluginActivationInputs } from "./activation-context.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
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
  const autoEnabled = resolvePluginActivationInputs({
    rawConfig: params.config,
    env,
    applyAutoEnable: true,
  });
  const bundledProviderCompatPluginIds =
    params.bundledProviderAllowlistCompat || params.bundledProviderVitestCompat
      ? resolveBundledProviderCompatPluginIds({
          config: autoEnabled.config,
          workspaceDir: params.workspaceDir,
          env,
          onlyPluginIds: params.onlyPluginIds,
        })
      : [];
  const activation = resolvePluginActivationInputs({
    rawConfig: params.config,
    resolvedConfig: autoEnabled.config,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    env,
    compat: {
      allowlistPluginIds: params.bundledProviderAllowlistCompat
        ? bundledProviderCompatPluginIds
        : undefined,
      enablementPluginIds: params.bundledProviderAllowlistCompat
        ? bundledProviderCompatPluginIds
        : undefined,
      vitestPluginIds: params.bundledProviderVitestCompat
        ? bundledProviderCompatPluginIds
        : undefined,
    },
  });
  const config = params.bundledProviderVitestCompat
    ? withBundledProviderVitestCompat({
        config: activation.config,
        pluginIds: bundledProviderCompatPluginIds,
        env,
      })
    : activation.config;
  const providerPluginIds = resolveEnabledProviderPluginIds({
    config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: params.onlyPluginIds,
  });
  const registry = resolveRuntimePluginRegistry({
    config,
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
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

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
