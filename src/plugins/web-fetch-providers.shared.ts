import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
import { type NormalizedPluginsConfig } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import { resolveManifestContractPluginIds } from "./manifest-registry.js";
import type { PluginWebFetchProviderEntry } from "./types.js";

function resolveBundledWebFetchCompatPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveManifestContractPluginIds({
    contract: "webFetchProviders",
    origin: "bundled",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}

function compareWebFetchProvidersAlphabetically(
  left: Pick<PluginWebFetchProviderEntry, "id" | "pluginId">,
  right: Pick<PluginWebFetchProviderEntry, "id" | "pluginId">,
): number {
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function sortWebFetchProviders(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return providers.toSorted(compareWebFetchProvidersAlphabetically);
}

export function sortWebFetchProvidersForAutoDetect(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return providers.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return compareWebFetchProvidersAlphabetically(left, right);
  });
}

export function resolveBundledWebFetchResolutionConfig(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): {
  config: PluginLoadOptions["config"];
  normalized: NormalizedPluginsConfig;
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
} {
  const activation = resolveBundledPluginCompatibleActivationInputs({
    rawConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    applyAutoEnable: true,
    compatMode: {
      allowlist: params.bundledAllowlistCompat,
      enablement: "always",
      vitest: true,
    },
    resolveCompatPluginIds: resolveBundledWebFetchCompatPluginIds,
  });

  return {
    config: activation.config,
    normalized: activation.normalized,
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
  };
}
