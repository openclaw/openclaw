import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeEmptyPluginMetadataOwners } from "../../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { buildDeclaredProviderOwnerIndex } from "../../plugins/provider-owner-index.js";

export function createVideoProviderSnapshot(params: {
  config?: OpenClawConfig;
  id: string;
  origin: PluginManifestRecord["origin"];
  referenceAudioInputs?: boolean;
  unrelatedPluginCount?: number;
  videoPluginCount?: number;
  workspaceDir?: string;
}): PluginMetadataSnapshot {
  // Plugin-backed provider snapshots are synthesized here so tool behavior can
  // be tested without loading plugin manifests from disk.
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const providerPlugin: PluginManifestRecord = {
    id: params.id,
    origin: params.origin,
    rootDir: `/plugins/${params.id}`,
    source: `/plugins/${params.id}/index.js`,
    manifestPath: `/plugins/${params.id}/openclaw.plugin.json`,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    contracts: { videoGenerationProviders: [params.id] },
    videoGenerationProviderMetadata:
      params.referenceAudioInputs === undefined
        ? undefined
        : {
            [params.id]: { referenceAudioInputs: params.referenceAudioInputs },
          },
  };
  const plugins = [
    ...Array.from({ length: params.videoPluginCount ?? 1 }, (_, index) => {
      const id = index === 0 ? params.id : `${params.id}-${index}`;
      return {
        ...providerPlugin,
        id,
        contracts: { videoGenerationProviders: [id] },
      };
    }),
    ...Array.from({ length: params.unrelatedPluginCount ?? 0 }, (_, index) => ({
      ...providerPlugin,
      id: `unrelated-${index}`,
      rootDir: `/plugins/unrelated-${index}`,
      source: `/plugins/unrelated-${index}/index.js`,
      manifestPath: `/plugins/unrelated-${index}/openclaw.plugin.json`,
      contracts: index % 2 === 0 ? undefined : { videoGenerationProviders: [] },
    })),
  ];
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.id,
      manifestPath: plugin.manifestPath,
      manifestHash: "test",
      source: plugin.source,
      rootDir: plugin.rootDir,
      origin: params.origin,
      enabled: true,
      startup: {
        sidecar: false,
        memory: false,
        agentHarnesses: [],
      },
      compat: [],
    })),
    diagnostics: [],
  };
  return {
    policyHash,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId,
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(plugins),
    owners: makeEmptyPluginMetadataOwners(),
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: plugins.length,
      manifestPluginCount: plugins.length,
    },
  };
}
