import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createStaticModelIdMatcher } from "../agents/embedded-agent-runner/model.static-id.js";
import {
  prepareImplicitProviderStaticCatalog,
  resolveImplicitProviders,
} from "../agents/models-config.providers.implicit.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  prepareConfiguredRuntimeModels,
} from "../agents/prepared-model-runtime.configured.js";
import { attachModelProviderRequestRouteFacts } from "../agents/provider-request-config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  prepareProviderStaticCatalog,
  resolvePreparedProviderStaticConfigs,
} from "./provider-discovery.js";
import type { ProviderPlugin } from "./types.js";

const fixture = vi.hoisted(() => ({ providers: [] as ProviderPlugin[] }));
vi.mock("./provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => fixture.providers,
}));

function model(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 2_048,
  };
}

function staticProvider(id: string, config: ModelProviderConfig, label = id) {
  return { id, label, auth: [], staticCatalog: { run: vi.fn(async () => ({ provider: config })) } };
}

type RuntimeParams = Parameters<typeof prepareConfiguredRuntimeModels>[0];
function catalogReader(provider: string, metadata: RuntimeParams["metadataSnapshot"]) {
  const matchesStaticModelId = createStaticModelIdMatcher({
    manifestPlugins: metadata.manifestRegistry.plugins,
  });
  return {
    read(
      preparedStaticProviderCatalog: RuntimeParams["preparedStaticProviderCatalog"],
      configuredModelRefs: RuntimeParams["configuredModelRefs"],
      config: OpenClawConfig = {},
    ) {
      return prepareConfiguredRuntimeModels({
        config,
        configuredModelRefs,
        preparedStaticProviderCatalog,
        matchesStaticModelId,
        metadataSnapshot: metadata,
        inlineProviderModels: [],
        providerStaticModels: [],
        resolveStaticCatalogModel: () => undefined,
      });
    },
    expected({ models, ...transport }: ModelProviderConfig) {
      return models.map((row) => ({
        provider,
        modelId: row.id,
        model: attachModelProviderRequestRouteFacts(
          { ...row, provider, ...transport },
          metadata.owners,
        ),
      }));
    },
  };
}

it("keeps first-match configured precedence and last-entry aggregate precedence", async () => {
  const provider = "catalog-precedence";
  const reader = catalogReader(provider, createPluginMetadataSnapshotFixture());
  const first: ModelProviderConfig = {
    api: "openai-completions",
    baseUrl: "https://first.example.invalid/v1",
    models: [model("shared-model", "First match"), model("shared-model", "Later duplicate")],
  };
  const last = {
    ...first,
    baseUrl: "https://last.example.invalid/v1",
    models: [model("shared-model", "Last entry")],
  };
  const prepared = await prepareProviderStaticCatalog({
    providers: [first, last].map((config, index) =>
      staticProvider(provider, config, `Owner ${index}`),
    ),
  });
  const configured = reader.read(prepared, [{ provider, modelId: "shared-model" }]);
  expect(configured).toEqual(reader.expected({ ...first, models: first.models.slice(0, 1) }));
  expect(resolvePreparedProviderStaticConfigs(prepared)).toEqual({ [provider]: last });
});

it("shares a workspace catalog across configured and implicit agent reads", async () => {
  const providerId = "catalog-copy-fixture";
  const pluginId = "catalog-copy-owner";
  const agentCount = 32;
  const modelsPerAgent = 32;
  const models = Array.from({ length: agentCount * modelsPerAgent }, (_, index) =>
    model(`model-${index}`, `Model ${index}`),
  );
  const providerConfig: ModelProviderConfig = {
    api: "openai-completions",
    baseUrl: "https://catalog.example.invalid/v1",
    headers: { "X-Catalog": "fixture" },
    models,
  };
  const provider = staticProvider(providerId, providerConfig);
  fixture.providers = [
    { ...provider, pluginId, staticCatalog: { ...provider.staticCatalog, order: "simple" } },
  ];
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [{ id: pluginId, providers: [providerId] }],
  });
  const reader = catalogReader(providerId, metadata);
  const agents = Object.fromEntries(
    Array.from({ length: agentCount }, (_, index) => {
      const refs = models
        .slice(index * modelsPerAgent, (index + 1) * modelsPerAgent)
        .map((row) => `${providerId}/${row.id}`);
      return [
        `agent-${index}`,
        {
          model: {
            primary: expectDefined(refs[0], "primary model reference"),
            fallbacks: refs.slice(1),
          },
        },
      ];
    }),
  );
  const config: OpenClawConfig = { agents: { entries: agents } };
  const prepared = await prepareImplicitProviderStaticCatalog({
    config,
    env: {},
    pluginMetadataSnapshot: metadata,
    providerDiscoveryProviderIds: [providerId],
    staticCatalogProviderIds: [providerId],
  });
  const materialized = Object.keys(agents).flatMap((agentId) =>
    reader.read(
      prepared,
      collectPreparedModelRuntimeConfiguredRefs(config, agentId).map(({ value }) =>
        expectDefined(parseModelCatalogRef(value), "parsed configured model reference"),
      ),
      config,
    ),
  );
  const implicitParams = {
    config,
    env: {},
    authStore: { version: 1, profiles: {} },
    pluginMetadataSnapshot: metadata,
    preparedStaticProviderCatalog: prepared,
    providerDiscoveryEntriesOnly: true,
    providerDiscoveryProviderIds: [providerId],
  };
  const overridden = await resolveImplicitProviders({
    ...implicitParams,
    agentDir: "/catalog-copy-fixture/agent-one",
    explicitProviders: {
      [providerId]: {
        ...providerConfig,
        headers: { "X-Catalog": "agent-one" },
        models: [
          {
            ...expectDefined(models[0], "first catalog model"),
            name: "Agent override",
            contextWindow: 64_000,
          },
        ],
      },
    },
  });
  expect(overridden?.[providerId]?.headers).toEqual({ "X-Catalog": "agent-one" });
  expect(overridden?.[providerId]?.models[0]).toMatchObject({
    id: "model-0",
    name: "Agent override",
    contextWindow: 64_000,
  });
  const unchanged = await resolveImplicitProviders({
    ...implicitParams,
    agentDir: "/catalog-copy-fixture/agent-two",
  });
  expect(unchanged?.[providerId]).toEqual(providerConfig);
  expect(prepared.entries[0]?.providerConfigs[providerId]).toEqual(providerConfig);
  expect(providerConfig.headers).toEqual({ "X-Catalog": "fixture" });
  expect(providerConfig.models[0]).toMatchObject({
    id: "model-0",
    name: "Model 0",
    contextWindow: 32_000,
  });
  expect(provider.staticCatalog.run).toHaveBeenCalledOnce();
  expect(materialized).toEqual(reader.expected(providerConfig));
  expect(resolvePreparedProviderStaticConfigs(prepared)).toEqual({ [providerId]: providerConfig });
});
