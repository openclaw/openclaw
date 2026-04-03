import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
import { resolveBundledWebSearchPluginIds } from "./bundled-web-search.js";
import { type NormalizedPluginsConfig } from "./config-state.js";
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

function compareWebSearchProvidersAlphabetically(
  left: Pick<PluginWebSearchProviderEntry, "id" | "pluginId">,
  right: Pick<PluginWebSearchProviderEntry, "id" | "pluginId">,
): number {
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function sortWebSearchProviders(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return providers.toSorted(compareWebSearchProvidersAlphabetically);
}

export function sortWebSearchProvidersForAutoDetect(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return providers.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return compareWebSearchProvidersAlphabetically(left, right);
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
    resolveCompatPluginIds: resolveBundledWebSearchCompatPluginIds,
  });

  return {
    config: activation.config,
    normalized: activation.normalized,
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
  };
}
