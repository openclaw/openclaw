// Resolves manifest contracts into runtime-facing plugin capabilities.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasManifestContractValue,
  listAvailableManifestContractPlugins,
} from "./manifest-contract-eligibility.js";
import type { PluginManifestContractListKey } from "./manifest-registry.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

export type ManifestContractRuntimePluginResolution = {
  pluginIds: string[];
  bundledCompatPluginIds: string[];
};

<<<<<<< HEAD
=======
const DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS = {
  preferPersisted: false,
} as const;

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function resolveManifestContractRuntimePluginResolution(params: {
  cfg?: OpenClawConfig;
  contract: PluginManifestContractListKey;
  value?: string;
}): ManifestContractRuntimePluginResolution {
  const snapshot = loadPluginMetadataSnapshot({
    config: params.cfg ?? {},
    env: process.env,
<<<<<<< HEAD
=======
    ...DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });
  const allContractPlugins = snapshot.plugins.filter((plugin) =>
    hasManifestContractValue({
      plugin,
      contract: params.contract,
      value: params.value,
    }),
  );
  const bundledCompatPluginIds = allContractPlugins
    .filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => plugin.id);
  const pluginIds = listAvailableManifestContractPlugins({
    snapshot: { index: snapshot.index, plugins: allContractPlugins },
    contract: params.contract,
    value: params.value,
    config: params.cfg,
  }).map((plugin) => plugin.id);
  return {
    pluginIds: sortUniqueStrings(pluginIds),
    bundledCompatPluginIds: sortUniqueStrings(bundledCompatPluginIds),
  };
}
