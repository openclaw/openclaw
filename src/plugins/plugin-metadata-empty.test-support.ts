import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

export function createEmptyPluginMetadataSnapshot(workspaceDir?: string): PluginMetadataSnapshot {
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "",
    generatedAtMs: 1,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash: "",
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    declaredProviderOwners: new Map(),
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
      providerAuthContributions: [],
      modelIdNormalizationPolicies: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
}
