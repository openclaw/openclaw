// Resolves manifest contracts into runtime-facing plugin capabilities.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasManifestContractValue,
  isManifestPluginAvailableForControlPlane,
} from "./manifest-contract-eligibility.js";
import type { PluginManifestContractListKey, PluginManifestRecord } from "./manifest-registry.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

export type ManifestContractRuntimePluginResolution = {
  pluginIds: string[];
  bundledCompatPluginIds: string[];
};

const DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS = {
  preferPersisted: false,
} as const;

type ReadableManifestContractPlugin = Pick<
  PluginManifestRecord,
  "contracts" | "enabledByDefault" | "enabledByDefaultOnPlatforms" | "id" | "origin"
>;

export function resolveManifestContractRuntimePluginResolution(params: {
  cfg?: OpenClawConfig;
  contract: PluginManifestContractListKey;
  value?: string;
}): ManifestContractRuntimePluginResolution {
  const snapshot = loadPluginMetadataSnapshot({
    config: params.cfg ?? {},
    env: process.env,
    ...DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS,
  });
  const allContractPlugins = snapshot.plugins.flatMap((plugin) => {
    const readable = readManifestContractRuntimePlugin({
      plugin,
      contract: params.contract,
      value: params.value,
    });
    return readable ? [readable] : [];
  });
  const bundledCompatPluginIds = allContractPlugins
    .filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => plugin.id);
  const pluginIds = allContractPlugins
    .filter((plugin) =>
      isManifestPluginAvailableForControlPlane({
        snapshot: { index: snapshot.index },
        plugin,
        config: params.cfg,
      }),
    )
    .map((plugin) => plugin.id);
  return {
    pluginIds: sortUniqueStrings(pluginIds),
    bundledCompatPluginIds: sortUniqueStrings(bundledCompatPluginIds),
  };
}

function readManifestContractRuntimePlugin(params: {
  plugin: PluginManifestRecord;
  contract: PluginManifestContractListKey;
  value?: string;
}): ReadableManifestContractPlugin | undefined {
  try {
    const plugin = {
      contracts: params.plugin.contracts,
      enabledByDefault: params.plugin.enabledByDefault,
      enabledByDefaultOnPlatforms: params.plugin.enabledByDefaultOnPlatforms,
      id: params.plugin.id,
      origin: params.plugin.origin,
    };
    if (
      !hasManifestContractValue({
        plugin,
        contract: params.contract,
        value: params.value,
      })
    ) {
      return undefined;
    }
    return plugin;
  } catch {
    return undefined;
  }
}
