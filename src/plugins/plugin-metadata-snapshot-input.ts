/** Acquires workspace metadata before the fleet publishes its immutable snapshot. */
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type {
  LoadPluginMetadataSnapshotParams,
  PluginMetadataSnapshotInput,
} from "./plugin-metadata-snapshot.types.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";

export function loadPluginMetadataSnapshotInput(
  params: LoadPluginMetadataSnapshotParams,
  readRegistry: () => ReturnType<typeof loadPluginRegistrySnapshotWithMetadata> = () =>
    loadPluginRegistrySnapshotWithMetadata({
      config: params.config,
      workspaceDir: params.workspaceDir,
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      env: params.env,
      ...(params.installRecords !== undefined
        ? { preferPersisted: false }
        : params.preferPersisted !== undefined
          ? { preferPersisted: params.preferPersisted }
          : {}),
      ...(params.allowCurrent !== undefined ? { allowCurrent: params.allowCurrent } : {}),
      ...(params.index ? { index: params.index } : {}),
      ...(params.installRecords ? { installRecords: params.installRecords } : {}),
    }),
): PluginMetadataSnapshotInput {
  const totalStartedAt = performance.now();
  const registryStartedAt = performance.now();
  const registryResult = readRegistry();
  const registrySnapshotMs = performance.now() - registryStartedAt;
  const index = registryResult.snapshot.diagnostics
    ? registryResult.snapshot
    : { ...registryResult.snapshot, diagnostics: [] };
  const manifestStartedAt = performance.now();
  // Empty installed indexes are authoritative; bootstrap first derives a real
  // index so every manifest and scope follows the same immutable graph.
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    registryPath: resolveInstalledPluginIndexStorePath({
      env: params.env,
      stateDir: params.stateDir,
    }),
    ...(registryResult.manifestRegistry
      ? { manifestRegistry: registryResult.manifestRegistry }
      : {}),
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  const manifestRegistryMs = performance.now() - manifestStartedAt;
  const totalMs = performance.now() - totalStartedAt;

  return {
    policyHash: index.policyHash,
    registrySource: registryResult.source,
    workspaceDir: params.workspaceDir,
    index,
    registryIndex: index,
    registryDiagnostics: registryResult.diagnostics,
    manifestRegistry,
    metrics: {
      registrySnapshotMs,
      manifestRegistryMs,
      ownerMapsMs: 0,
      totalMs,
      indexPluginCount: index.plugins.length,
      manifestPluginCount: manifestRegistry.plugins.length,
    },
    discovery: registryResult.discovery,
  };
}
