import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestContractListKey } from "./manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

export type ManifestContractRuntimePluginResolution = {
  pluginIds: string[];
  bundledCompatPluginIds: string[];
};

const DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS = {
  preferPersisted: false,
} as const;

function hasManifestContractValue(
  plugin: ReturnType<typeof loadPluginManifestRegistryForPluginRegistry>["plugins"][number],
  contract: PluginManifestContractListKey,
  value?: string,
): boolean {
  const values = plugin.contracts?.[contract] ?? [];
  return values.length > 0 && (!value || values.includes(value));
}

export function resolveManifestContractRuntimePluginResolution(params: {
  cfg?: OpenClawConfig;
  contract: PluginManifestContractListKey;
  value?: string;
}): ManifestContractRuntimePluginResolution {
  const allContractPlugins = loadPluginManifestRegistryForPluginRegistry({
    config: params.cfg,
    env: process.env,
    includeDisabled: true,
    ...DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS,
  }).plugins.filter((plugin) => hasManifestContractValue(plugin, params.contract, params.value));
  const bundledCompatPluginIds = allContractPlugins
    .filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => plugin.id);
  const enabledPluginIds = new Set(
    loadPluginManifestRegistryForPluginRegistry({
      config: params.cfg,
      env: process.env,
      ...DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS,
    }).plugins.map((plugin) => plugin.id),
  );
  const pluginIds = allContractPlugins
    .filter((plugin) => plugin.origin === "bundled" || enabledPluginIds.has(plugin.id))
    .map((plugin) => plugin.id);
  return {
    pluginIds: [...new Set(pluginIds)].toSorted((left, right) => left.localeCompare(right)),
    bundledCompatPluginIds: [...new Set(bundledCompatPluginIds)].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
}
