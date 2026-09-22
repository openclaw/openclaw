import path from "node:path";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { preparePublishedModelCatalogOwnerIdentity } from "../prepared-model-catalog-owner.js";
import { createCatalogFixture } from "../prepared-model-catalog-worker.test-support.js";
import { startSerializedSnapshotBuildBatch } from "../prepared-model-runtime.build.js";
import { retainPreparedPluginGeneration } from "../prepared-model-runtime.plugin-lifetime.js";
import { markPluginMetadataSnapshotProvided } from "./prepared-model-catalog-worker-fixture.js";

export function createStaticCatalogSnapshotFixture(params: {
  makeTempDir: (prefix: string) => string;
  retireAfterTest: (retire: () => void | Promise<void>) => void;
}) {
  const { makeTempDir, retireAfterTest } = params;
  return async function createStaticSnapshot(
    spinMs: number,
    envOverride: NodeJS.ProcessEnv = {},
    options?: {
      hydrateExternalCliProviderIds?: readonly string[];
      codexNativeOwner?: boolean;
      builtPluginVersion?: string;
      asyncSyntheticAuth?: boolean;
      prepareInboundPluginRegistry?: boolean;
      readOnly?: boolean;
      metadataWorkspace?: "gateway" | "none" | "activation";
      provideMetadataToWorker?: boolean;
    },
  ) {
    const fixture = createCatalogFixture(makeTempDir, spinMs, envOverride, options);
    const { agentDir, workspaceDir, config, env, root } = fixture;
    const input = {
      agentId: "main",
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir,
      config,
      env,
      ...(options?.readOnly ? { readOnly: true } : {}),
    };
    let current = true;
    const isCurrent = () => current;
    const supersede = () => {
      current = false;
    };
    retireAfterTest(supersede);
    const loadedMetadataSnapshot = options?.metadataWorkspace
      ? loadPluginMetadataSnapshot({
          config:
            options.metadataWorkspace === "activation"
              ? { ...config, plugins: { ...config.plugins, entries: {} } }
              : config,
          env,
          ...(options.metadataWorkspace === "gateway"
            ? { workspaceDir: path.join(root, "gateway-workspace") }
            : {}),
        })
      : undefined;
    const providedMetadataSnapshot =
      options?.provideMetadataToWorker && loadedMetadataSnapshot
        ? markPluginMetadataSnapshotProvided(loadedMetadataSnapshot)
        : loadedMetadataSnapshot;
    const results = await startSerializedSnapshotBuildBatch(
      [
        {
          input,
          catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
          isGenerationCurrent: isCurrent,
          isBuildCurrent: isCurrent,
          prepareInboundPluginRegistry: options?.prepareInboundPluginRegistry,
        },
      ],
      new Map(),
      30_000,
      "static",
      undefined,
      providedMetadataSnapshot,
    ).pending;
    const build = results[0]!;
    const releaseGeneration = retainPreparedPluginGeneration(build.pluginGeneration);
    retireAfterTest(releaseGeneration);
    return {
      ...fixture,
      pluginMetadataSnapshot: build.pluginGeneration.pluginMetadataSnapshot,
      snapshot: build.snapshot,
      isCurrent,
      supersede,
      releaseGeneration,
    };
  };
}
