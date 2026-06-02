import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
import {
  resolveBundledWebProviderResolutionConfig,
  sortPluginProviders,
  sortPluginProvidersForAutoDetect,
} from "./web-provider-resolution-shared.js";

export function sortWebSearchProviders(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return sortPluginProviders(providers);
}

/**
 * Sorts search providers for automatic provider selection.
 *
 * Search selection follows shared web-provider priority rules: explicit manifest
 * `autoDetectOrder` first, then deterministic provider/plugin id ordering.
 */
export function sortWebSearchProvidersForAutoDetect(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return sortPluginProvidersForAutoDetect(providers);
}

/**
 * Resolves config values used while discovering bundled web-search providers.
 *
 * The returned config includes compat auto-enablement for bundled search
 * plugins, keeping runtime/setup callers free of plugin-id-specific defaults.
 */
export function resolveBundledWebSearchResolutionConfig(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): {
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
} {
  return resolveBundledWebProviderResolutionConfig({
    contract: "webSearchProviders",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}
