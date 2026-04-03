import { resolvePluginActivationInputs } from "./activation-context.js";
import { resolveBundledWebFetchPluginIds } from "./bundled-web-fetch.js";
import { type NormalizedPluginsConfig } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebFetchProviderEntry } from "./types.js";

function resolveBundledWebFetchCompatPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveBundledWebFetchPluginIds({
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
  const autoEnabled = resolvePluginActivationInputs({
    rawConfig: params.config,
    env: params.env,
    applyAutoEnable: true,
  });
  const bundledCompatPluginIds = resolveBundledWebFetchCompatPluginIds({
    config: autoEnabled.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const activation = resolvePluginActivationInputs({
    rawConfig: params.config,
    resolvedConfig: autoEnabled.config,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    env: params.env,
    compat: {
      allowlistPluginIds: params.bundledAllowlistCompat ? bundledCompatPluginIds : undefined,
      enablementPluginIds: bundledCompatPluginIds,
      vitestPluginIds: bundledCompatPluginIds,
    },
  });

  return {
    config: activation.config,
    normalized: activation.normalized,
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
  };
}
