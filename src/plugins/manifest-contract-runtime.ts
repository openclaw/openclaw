import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasManifestContractValue,
  listAvailableManifestContractPlugins,
} from "./manifest-contract-eligibility.js";
import type { PluginManifestContractListKey, PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginMetadataSnapshotAsync } from "./plugin-metadata-snapshot.js";

type ManifestContractRuntimePluginResolution = {
  pluginIds: string[];
  bundledCompatPluginIds: string[];
  plugins: PluginManifestRecord[];
};

export async function resolveManifestContractRuntimePluginResolution(params: {
  cfg?: OpenClawConfig;
  contract: PluginManifestContractListKey;
  value?: string;
}): Promise<ManifestContractRuntimePluginResolution> {
  const snapshot = await resolvePluginMetadataSnapshotAsync({
    config: params.cfg ?? {},
    env: process.env,
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
    plugins: allContractPlugins,
  };
}
