import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebFetchProviderEntry } from "./types.js";
import {
  resolveBundledWebProviderResolutionConfig,
  sortPluginProviders,
  sortPluginProvidersForAutoDetect,
} from "./web-provider-resolution-shared.js";

export function sortWebFetchProviders(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return sortPluginProviders(providers);
}

/**
 * Sorts fetch providers for automatic provider selection.
 *
 * This keeps the fetch runtime aligned with shared web-provider priority rules:
 * manifest `autoDetectOrder` first, deterministic provider/plugin id fallback.
 */
export function sortWebFetchProvidersForAutoDetect(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return sortPluginProvidersForAutoDetect(providers);
}

/**
 * Resolves config values used while discovering bundled web-fetch providers.
 *
 * The returned config includes compat auto-enablement for bundled fetch plugins
 * so callers can discover legacy providers without encoding plugin ids locally.
 */
export function resolveBundledWebFetchResolutionConfig(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): {
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
} {
  return resolveBundledWebProviderResolutionConfig({
    contract: "webFetchProviders",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}
