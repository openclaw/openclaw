import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginManifestRecordFixture } from "../../plugins/plugin-metadata.test-support.js";
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
  const { id, origin, referenceAudioInputs } = params;
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const providerPlugin = createPluginManifestRecordFixture({
    id,
    origin,
    rootDir: `/plugins/${id}`,
    videoGenerationProviderMetadata:
      referenceAudioInputs === undefined ? undefined : { [id]: { referenceAudioInputs } },
  });
  const plugins = [
    ...Array.from({ length: params.videoPluginCount ?? 1 }, (_, index) => {
      const pluginId = index === 0 ? id : `${id}-${index}`;
      return {
        ...providerPlugin,
        id: pluginId,
        contracts: { videoGenerationProviders: [pluginId] },
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
  const empty = createEmptyPluginMetadataSnapshot(params.workspaceDir || undefined);
  const index: PluginMetadataSnapshot["index"] = {
    ...empty.index,
    policyHash,
    generatedAtMs: 0,
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.id,
      manifestPath: plugin.manifestPath,
      manifestHash: "test",
      source: plugin.source,
      rootDir: plugin.rootDir,
      origin: params.origin,
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      compat: [],
    })),
  };
  return {
    ...empty,
    policyHash,
    index,
    registryIndex: index,
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(plugins),
    metrics: {
      ...empty.metrics,
      indexPluginCount: plugins.length,
      manifestPluginCount: plugins.length,
    },
  };
}
