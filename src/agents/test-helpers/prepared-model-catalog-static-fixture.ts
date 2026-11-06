import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { preparePublishedModelCatalogOwnerIdentity } from "../prepared-model-catalog-owner.js";
import {
  catalogInput,
  createCatalogFixture,
} from "../prepared-model-catalog-worker.test-support.js";
import { startSerializedSnapshotBuildBatch } from "../prepared-model-runtime.build.js";
import { retainPreparedPluginGeneration } from "../prepared-model-runtime.plugin-lifetime.js";
import { addCredentialOnlyProviderFixture } from "./prepared-model-catalog-credential-only.test-support.js";
import { markPluginMetadataSnapshotProvided } from "./prepared-model-catalog-worker-fixture.js";

export function createStaticCatalogSnapshotFixture(params: {
  makeTempDir: (prefix: string) => string;
  retireAfterTest: (retire: () => void | Promise<void>) => void;
  receiptBroadcastName?: () => string;
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
      credentialOnlySyntheticAuth?: boolean;
      prepareInboundPluginRegistry?: boolean;
      readOnly?: boolean;
      metadataWorkspace?: "none" | "activation";
      provideMetadataToWorker?: boolean;
      reportCodexClientVersion?: boolean;
    },
  ) {
    const fixture = await createCatalogFixture(makeTempDir, spinMs, envOverride, {
      ...options,
      receiptBroadcastName: params.receiptBroadcastName?.(),
    });
    const config = options?.credentialOnlySyntheticAuth
      ? addCredentialOnlyProviderFixture(fixture)
      : fixture.config;
    const input = catalogInput(fixture, {
      config,
      ...(options?.readOnly ? { readOnly: true } : {}),
    });
    const retirement = new AbortController();
    const isCurrent = () => !retirement.signal.aborted;
    const supersede = () => retirement.abort();
    retireAfterTest(supersede);
    let metadataSnapshot = options?.metadataWorkspace
      ? loadPluginMetadataSnapshot({
          config:
            options.metadataWorkspace === "activation"
              ? { ...config, plugins: { ...config.plugins, entries: {} } }
              : config,
          env: fixture.env,
        })
      : undefined;
    if (options?.provideMetadataToWorker && metadataSnapshot) {
      metadataSnapshot = markPluginMetadataSnapshotProvided(metadataSnapshot);
    }
    const results = await startSerializedSnapshotBuildBatch(
      [
        {
          input,
          catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
          isGenerationCurrent: isCurrent,
          retirementSignal: retirement.signal,
          isBuildCurrent: isCurrent,
          prepareInboundPluginRegistry: options?.prepareInboundPluginRegistry,
        },
      ],
      new Map(),
      30_000,
      "static",
      undefined,
      metadataSnapshot,
    ).pending;
    const build = results[0]!;
    const releaseGeneration = retainPreparedPluginGeneration(build.pluginGeneration);
    retireAfterTest(releaseGeneration);
    return {
      ...fixture,
      config,
      pluginMetadataSnapshot: build.pluginGeneration.pluginMetadataSnapshot,
      snapshot: build.snapshot,
      isCurrent,
      retirementSignal: retirement.signal,
      supersede,
      releaseGeneration,
    };
  };
}
