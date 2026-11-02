import { createModelCatalogDecisions } from "../../src/agents/model-catalog-decisions.js";
import { enrichHarnessRows } from "../../src/agents/model-catalog-entry.js";
import type { ModelCatalogEntry } from "../../src/agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { prepareModelsListResult } from "../../src/gateway/server-methods/models-list-result.js";
import { withRemoteModelCatalogSnapshot } from "../../src/model-catalog/remote-overlay.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import hosted from "../fixtures/model-catalog/hosted-meta.json" with { type: "json" };
import acceptedNative from "../fixtures/model-catalog/muse-meta-expected.json" with { type: "json" };
import openrouter from "../fixtures/model-catalog/openrouter-meta.json" with { type: "json" };

/** Source-response fixture composition through the real enrichment and picker projection. */
export async function projectMetaMuseFixture(workspace: string) {
  const api: ModelCatalogEntry[] = hosted.models
    .filter((row) => row.provider === "meta")
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      name: row.name,
      contextWindow: row.contextWindow,
      api: "openai-responses",
    }));
  const router: ModelCatalogEntry[] = openrouter.data.map((row) => ({
    id: row.id,
    provider: "openrouter",
    name: row.name,
    contextWindow: row.context_length,
    api: "openai-completions",
  }));
  const native = enrichHarnessRows(acceptedNative, { entries: api, routeVariants: api });
  const entries = [
    ...api,
    ...native.filter((row) => !api.some((donor) => donor.id === row.id)),
    ...router,
  ];
  const snapshot = { entries, routeVariants: [...api, ...native, ...router] };
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace,
        modelPolicy: { allow: [] },
        models: { "meta/muse-spark-1.3": { agentRuntime: { id: "muse" } } },
      },
    },
  };
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "muse",
    source: "fixture",
    harness: {
      id: "muse",
      label: "Muse",
      authBootstrap: "harness",
      supports: ({ provider }) => ({ supported: provider === "meta" }),
      readModelCatalogReadiness: ({ modelId }) =>
        acceptedNative.some((row) => row.id === modelId)
          ? { accountType: "subscription", authMode: "oauth" }
          : undefined,
      async runAttempt() {
        throw new Error("Projection must not run inference");
      },
    },
  });
  const projector = createModelCatalogDecisions({
    cfg,
    agentId: "main",
    snapshot,
    pluginRegistry: registry,
    metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
    preparedAuthStore: {
      version: 1,
      profiles: {
        "openrouter:fixture": {
          type: "api_key",
          provider: "openrouter",
          key: "synthetic-fixture-key",
        },
      },
    },
  });
  return withRemoteModelCatalogSnapshot(
    {
      sourceUrl: "https://catalog.openclaw.ai/models/v2/catalog.json",
      generatedAt: hosted.generatedAt,
      revision: "source-fixture",
      providers: {},
      pricing: {},
      upstreamPricing: {},
      recommendations: { meta: hosted.providers.meta.recommendedModels },
    },
    async () => {
      const prepared = await prepareModelsListResult({
        source: {
          kind: "gateway",
          context: {
            getRuntimeConfig: () => cfg,
            loadGatewayModelCatalogSnapshot: async () => {
              throw new Error("Unexpected discovery");
            },
            logGateway: { debug: () => {} },
          },
        },
        agentId: "main",
        params: { view: "configured", includeDetails: true },
        preloadedCatalog: { agentId: "main", config: cfg, snapshot },
        preloadedOnly: true,
        catalogProjector: projector,
      });
      return prepared.read();
    },
  );
}
