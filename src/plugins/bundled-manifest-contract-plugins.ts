/** Resolves enabled bundled plugins that advertise a specific manifest contract list. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledCompatActivationInputs } from "./activation-context.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { loadManifestContractSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestContractListKey, PluginManifestRecord } from "./manifest-registry.js";
import { createPluginIdScopeSet } from "./plugin-scope.js";

/** Applies config activation and compatibility rules before returning bundled contract owners. */
export function resolveEnabledBundledManifestContractPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
  contract: PluginManifestContractListKey;
  manifestRecords?: readonly PluginManifestRecord[];
}): PluginManifestRecord[] {
  if (params.config?.plugins?.enabled === false) {
    return [];
  }
  let manifestRecords = params.manifestRecords;
  const onlyPluginIdSet = createPluginIdScopeSet(params.onlyPluginIds);
  const loadCandidates = () => {
    manifestRecords ??= loadManifestContractSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).plugins;
    return manifestRecords.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        (plugin.contracts?.[params.contract]?.length ?? 0) > 0,
    );
  };

  const activation = resolveBundledCompatActivationInputs({
    rawConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: params.onlyPluginIds,
    applyAutoEnable: true,
    resolveBundledPluginIds: () =>
      loadCandidates()
        .map((plugin) => plugin.id)
        .toSorted((left, right) => left.localeCompare(right)),
  });
  return loadCandidates().filter(
    (plugin) =>
      resolveEffectivePluginActivationState({
        id: plugin.id,
        origin: plugin.origin,
        channelIds: plugin.channels,
        config: activation.normalized,
        rootConfig: activation.config,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
        activationSource: activation.activationSource,
      }).enabled,
  );
}
