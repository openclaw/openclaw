import { expectDefined } from "@openclaw/normalization-core";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeBuildCandidate,
  PreparedModelRuntimeBuildResult,
} from "../agents/prepared-model-runtime.build.js";
import { createPreparedPluginGeneration } from "../agents/prepared-model-runtime.plugin-generation.js";
import type {
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "../agents/prepared-model-runtime.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";

export const buildFacts = {
  metadata: undefined as PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"] | undefined,
  derived: false,
  buildGate: undefined as Promise<void> | undefined,
};
// Synthetic catalog/facts fixture ONLY; publication owners, commits, leases, guard remain real.
export const runtimeAdmissionBuildModule = {
  startSerializedSnapshotBuildBatch: (
    candidates: readonly PreparedModelRuntimeBuildCandidate[],
    agentBuildCompletions: Map<string, Promise<void>>,
  ) => {
    const pending = (async () => {
      if (buildFacts.buildGate) {
        await buildFacts.buildGate;
      }
      return candidates.map((c): PreparedModelRuntimeBuildResult => {
        const base = c.pluginGeneration;
        const generation =
          base && !buildFacts.derived
            ? base
            : createPreparedPluginGeneration({
                mediaCapabilityProviders: undefined,
                messageToolCatalog: undefined,
                preparedStaticProviderCatalog: undefined,
                providerStaticModels: undefined,
                catalogMode: "static",
                reusablePluginGeneration: base,
                inlineProviderModels: [],
                configuredCatalogEntries: [],
                pluginMetadataSnapshot:
                  base?.pluginMetadataSnapshot ?? expectDefined(buildFacts.metadata, "metadata"),
                runtimePluginRegistry: createEmptyPluginRegistry(),
                inboundPluginRegistry: createEmptyPluginRegistry(),
              });
        const snapshot: PreparedModelRuntimeSnapshot = {
          ...c.input,
          activeProjectKeys: [],
          allowGatewaySubagentBinding: c.input.allowGatewaySubagentBinding ?? false,
          observationConfig: c.input.config,
          catalogOwner: c.catalogOwner,
          metadataSnapshot: generation.pluginMetadataSnapshot,
          configuredRuntimeModels: [],
          findConfiguredRuntimeModel: () => undefined,
          inlineProviderModels: [],
          createStores: () => {
            throw new Error("Provider stores must not be reached in admission proof");
          },
          authModes: {},
          isCurrent: () => true,
          modelCatalog: { entries: [], routeVariants: [] },
        };
        bindPreparedModelRuntimeAuth(snapshot, { store: { version: 1, profiles: {} } });
        return { pluginGeneration: generation, snapshot };
      });
    })();
    const completion = pending.then(
      () => {},
      () => {},
    );
    for (const candidate of candidates) {
      const dir = candidate.input.agentDir;
      agentBuildCompletions.set(dir, completion);
      void completion.then(() => {
        if (agentBuildCompletions.get(dir) === completion) {
          agentBuildCompletions.delete(dir);
        }
      });
    }
    return { pending, completion };
  },
};
