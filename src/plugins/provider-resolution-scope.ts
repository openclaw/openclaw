import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin, ProviderSyntheticAuthResult } from "./types.js";

export type ProviderResolutionScope = {
  providerPluginsForHooks: Map<string, ProviderPlugin[]>;
  providerRuntimePlugins: Map<string, ProviderPlugin | null>;
  owningPluginIdsForProvider: Map<string, string[] | undefined>;
  pluginDiscoveryProviders: Map<string, ProviderPlugin[]>;
  syntheticAuth: Map<string, ProviderSyntheticAuthResult | undefined>;
};

export function createProviderResolutionScope(): ProviderResolutionScope {
  return {
    providerPluginsForHooks: new Map(),
    providerRuntimePlugins: new Map(),
    owningPluginIdsForProvider: new Map(),
    pluginDiscoveryProviders: new Map(),
    syntheticAuth: new Map(),
  };
}

export function createProviderResolutionCacheKey(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
  providerRefs?: readonly string[];
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  extra?: unknown;
}): string {
  return JSON.stringify({
    provider: params.provider ?? null,
    workspaceDir: params.workspaceDir ?? null,
    env: params.env && params.env !== process.env ? "custom" : "process",
    plugins: params.config?.plugins ?? null,
    modelsProviders: params.config?.models?.providers ?? null,
    onlyPluginIds: params.onlyPluginIds ?? null,
    providerRefs: params.providerRefs ?? null,
    applyAutoEnable: params.applyAutoEnable ?? null,
    bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? null,
    bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? null,
    extra: params.extra ?? null,
  });
}
