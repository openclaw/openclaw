import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createStaticModelIdMatcher } from "../agents/embedded-agent-runner/model.static-id.js";
import { prepareImplicitProviderStaticCatalog } from "../agents/models-config.providers.implicit.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  prepareConfiguredRuntimeModels,
} from "../agents/prepared-model-runtime.configured.js";
import type { PreparedConfiguredRuntimeModel } from "../agents/prepared-model-runtime.types.js";
import { attachModelProviderRequestRouteFacts } from "../agents/provider-request-config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  prepareProviderStaticCatalog,
  resolvePreparedProviderStaticConfigs,
} from "./provider-discovery.js";
import type { ProviderPlugin } from "./types.js";

const fixture = vi.hoisted(() => ({
  providers: [] as ProviderPlugin[],
  rawRows: new WeakSet<object>(),
  idReads: 0,
}));

vi.mock("./provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => fixture.providers,
}));

// Delegate the safe reader without retaining mock arguments for every copied field.
vi.mock("../shared/safe-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/safe-record.js")>();
  return {
    ...actual,
    readRecordValue(value: unknown, key: string) {
      if (key === "id" && typeof value === "object" && value && fixture.rawRows.has(value)) {
        fixture.idReads += 1;
      }
      return actual.readRecordValue(value, key);
    },
  };
});

it("keeps first-match configured precedence and last-entry aggregate precedence", async () => {
  const providerId = "catalog-precedence";
  const metadata = createPluginMetadataSnapshotFixture();
  const model = (name: string): ModelDefinitionConfig => ({
    id: "shared-model",
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 2_048,
  });
  const first: ModelProviderConfig = {
    api: "openai-completions",
    baseUrl: "https://first.example.invalid/v1",
    models: [model("First match"), model("Later duplicate")],
  };
  const last: ModelProviderConfig = {
    ...first,
    baseUrl: "https://last.example.invalid/v1",
    models: [model("Last entry")],
  };
  const prepared = await prepareProviderStaticCatalog({
    providers: [first, last].map((provider, index) => ({
      id: providerId,
      label: `Owner ${index}`,
      auth: [],
      staticCatalog: { run: async () => ({ provider }) },
    })),
  });
  const configured = prepareConfiguredRuntimeModels({
    config: {},
    inlineProviderModels: [],
    configuredModelRefs: [{ provider: providerId, modelId: "shared-model" }],
    metadataSnapshot: metadata,
    preparedStaticProviderCatalog: prepared,
    providerStaticModels: [],
    resolveStaticCatalogModel: () => undefined,
    matchesStaticModelId: createStaticModelIdMatcher({ manifestPlugins: [] }),
  });
  expect(configured).toEqual([
    {
      provider: providerId,
      modelId: "shared-model",
      model: attachModelProviderRequestRouteFacts(
        {
          ...expectDefined(first.models[0], "first catalog model"),
          provider: providerId,
          api: first.api,
          baseUrl: first.baseUrl,
        },
        metadata.owners,
      ),
    },
  ]);
  expect(resolvePreparedProviderStaticConfigs(prepared)).toEqual({ [providerId]: last });
});

it("copies a workspace catalog once while materializing every agent's configured models", async () => {
  const providerId = "catalog-copy-fixture";
  const pluginId = "catalog-copy-owner";
  const agentCount = 32;
  const modelsPerAgent = 32;
  const models: ModelDefinitionConfig[] = Array.from(
    { length: agentCount * modelsPerAgent },
    (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 2_048,
    }),
  );
  const providerConfig: ModelProviderConfig = {
    api: "openai-completions",
    baseUrl: "https://catalog.example.invalid/v1",
    headers: { "X-Catalog": "fixture" },
    models,
  };
  let hookCalls = 0;
  const provider: ProviderPlugin = {
    id: providerId,
    pluginId,
    label: "Catalog copy fixture",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => {
        hookCalls += 1;
        return { provider: providerConfig };
      },
    },
  };
  fixture.providers = [provider];
  fixture.rawRows = new WeakSet(models);
  fixture.idReads = 0;
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [{ id: pluginId, providers: [providerId] }],
  });
  const agents = Array.from({ length: agentCount }, (_, index) => {
    const refs = models
      .slice(index * modelsPerAgent, (index + 1) * modelsPerAgent)
      .map((model) => `${providerId}/${model.id}`);
    return {
      id: `agent-${index}`,
      model: {
        primary: expectDefined(refs[0], "primary model reference"),
        fallbacks: refs.slice(1),
      },
    };
  });
  const config: OpenClawConfig = { agents: { list: agents } };
  const prepared = await prepareImplicitProviderStaticCatalog({
    config,
    env: {},
    pluginMetadataSnapshot: metadata,
    providerDiscoveryProviderIds: [providerId],
    staticCatalogProviderIds: [providerId],
  });
  const preparationReads = fixture.idReads;
  const matchesStaticModelId = createStaticModelIdMatcher({
    manifestPlugins: metadata.manifestRegistry.plugins,
  });
  const materialized: PreparedConfiguredRuntimeModel[] = [];
  for (const agent of agents) {
    const configuredModelRefs = collectPreparedModelRuntimeConfiguredRefs(config, agent.id).map(
      ({ value }) =>
        expectDefined(parseModelCatalogRef(value), "parsed configured model reference"),
    );
    materialized.push(
      ...prepareConfiguredRuntimeModels({
        config,
        inlineProviderModels: [],
        configuredModelRefs,
        metadataSnapshot: metadata,
        preparedStaticProviderCatalog: prepared,
        providerStaticModels: [],
        resolveStaticCatalogModel: () => undefined,
        matchesStaticModelId,
      }),
    );
  }
  const configuredReads = fixture.idReads - preparationReads;
  const resolvedProviders = resolvePreparedProviderStaticConfigs(prepared);
  const aggregateReads = fixture.idReads - preparationReads - configuredReads;

  expect(hookCalls).toBe(1);
  expect(materialized).toEqual(
    models.map((model) => ({
      provider: providerId,
      modelId: model.id,
      model: attachModelProviderRequestRouteFacts(
        {
          ...model,
          provider: providerId,
          api: providerConfig.api,
          baseUrl: providerConfig.baseUrl,
          headers: providerConfig.headers,
        },
        metadata.owners,
      ),
    })),
  );
  expect(resolvedProviders).toEqual({ [providerId]: providerConfig });
  expect(preparationReads + configuredReads + aggregateReads, "raw catalog model ID reads").toBe(
    models.length,
  );
});
