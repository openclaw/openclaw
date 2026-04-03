import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
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
  const activation = resolveBundledPluginCompatibleActivationInputs({
    rawConfig: params.config,
    env,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: params.onlyPluginIds,
    applyAutoEnable: true,
    compatMode: {
      allowlist: params.bundledProviderAllowlistCompat,
      enablement: "allowlist",
      vitest: params.bundledProviderVitestCompat,
    },
    resolveCompatPluginIds: resolveBundledProviderCompatPluginIds,
  });
  const config = params.bundledProviderVitestCompat
    ? withBundledProviderVitestCompat({
        config: activation.config,
        pluginIds: activation.compatPluginIds,
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
