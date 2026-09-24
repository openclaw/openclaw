import type { PluginInstallRecord } from "../config/types.plugins.js";
import { getGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import {
  buildPluginManifestRegistry,
  type PluginManifestRegistryBuildParams,
} from "./manifest-registry-build.js";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";

export type {
  BundledChannelConfigCollector,
  PluginManifestContractListKey,
  PluginManifestRecord,
  PluginManifestRegistry,
} from "./manifest-registry.types.js";

export function loadPluginManifestRegistryCore(
  params: Omit<PluginManifestRegistryBuildParams, "getInstallRecords"> & {
    installRecords?: Record<string, PluginInstallRecord>;
  } = {},
): PluginManifestRegistry {
  // Explicit candidates belong to startup/install inspection. Ordinary runtime
  // readers use the boot descriptors, including when config policy changes.
  if (!params.candidates && !params.discovery && !params.installRecords) {
    const gatewaySnapshot = getGatewayPluginMetadataSnapshot();
    if (gatewaySnapshot) {
      return gatewaySnapshot.manifestRegistry;
    }
  }
  const env = params.env ?? process.env;
  let installRecords = params.installRecords;
  return buildPluginManifestRegistry({
    ...params,
    env,
    // Candidate validation can finish without consulting persisted state. Keep
    // acquisition lazy and shared by discovery, trust and duplicate precedence.
    getInstallRecords: () =>
      (installRecords ??= loadInstalledPluginIndexInstallRecordsSync({ env })),
  });
}
