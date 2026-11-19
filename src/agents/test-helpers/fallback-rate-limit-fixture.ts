import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOpenClawPlugins, writePlugin } from "../../plugins/loader.test-fixtures.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { PreparedModelRuntimeAgentFacts } from "../prepared-model-runtime.catalog-contract.js";
import { createPreparedModelRuntimeSnapshot } from "../prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { AuthStorage } from "../sessions/auth-storage.core.js";
import { ModelRegistry } from "../sessions/model-registry.js";

/** Synthetic config and real snapshot publication, shared by the regression and CPU workload. */
export function createFallbackRateLimitFixture(
  baseUrl = "https://synthetic.invalid/v1",
  loadPlugins = false,
  transportSuffix = "transport",
) {
  const providers = ["synthetic-first", "synthetic-second", "synthetic-third"];
  const models = ["primary", "backup", "last"];
  const config: OpenClawConfig = freezeJsonSnapshot({
    agents: {
      defaults: {
        model: {
          primary: `${providers[0]}/primary`,
          fallbacks: [
            `${providers[1]}/backup`,
            `${providers[2]}/last`,
            `${providers[0]}/backup`,
            `${providers[1]}/last`,
            `${providers[2]}/primary`,
          ],
        },
      },
    },
    models: {
      providers: Object.fromEntries(
        providers.map((provider) => [
          provider,
          {
            api: "openai-completions" as const,
            auth: "api-key" as const,
            apiKey: "synthetic-fixture-key",
            baseUrl,
            models: models.map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text" as const],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100_000,
              maxTokens: 4096,
            })),
          },
        ]),
      ),
    },
    ...(loadPlugins ? { channels: { discord: { token: "synthetic-discord-token" } } } : {}),
    plugins: {
      allow: providers,
      slots: { memory: "none" },
      entries: Object.fromEntries(
        [...providers, ...Array.from({ length: 45 }, (_, i) => `synthetic-plugin-${i}`)].map(
          (id) => [id, { ...(loadPlugins ? {} : { enabled: true }), config: { fixture: id } }],
        ),
      ),
    },
  });
  const executable = loadPlugins
    ? providers.map((id) =>
        writePlugin({
          id,
          configSchema: { type: "object", properties: { fixture: { type: "string" } } },
          registration: `api.registerProvider({ id: ${JSON.stringify(id)}, label: "Synthetic", auth: [],
      normalizeTransport: ({ api, baseUrl }) => ({ api, baseUrl: baseUrl.endsWith(${JSON.stringify("/" + transportSuffix)}) ? baseUrl : baseUrl + ${JSON.stringify("/" + transportSuffix)} }),
      normalizeResolvedModel: ({ model }) => ({ ...model, id: model.id + "-wire" }) });`,
        }),
      )
    : [];
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: Object.keys(config.plugins!.entries!).map((id) => ({
      id,
      origin: "config",
      rootDir: executable.find((plugin) => plugin.id === id)?.dir ?? `/synthetic/${id}`,
      source: executable.find((plugin) => plugin.id === id)?.file ?? `/synthetic/${id}/index.js`,
      configSchema: { type: "object", properties: { fixture: { type: "string" } } },
      providers: providers.includes(id) ? [id] : [],
    })),
  });
  metadata.discovery = {
    candidates: executable.map((plugin) => ({
      idHint: plugin.id,
      rootDir: plugin.dir,
      source: plugin.file,
      origin: "config" as const,
    })),
    diagnostics: [],
  };
  const pluginRegistry = loadPlugins
    ? loadOpenClawPlugins({
        config,
        metadataSnapshot: metadata,
        onlyPluginIds: providers,
        installRecords: {},
        activate: false,
        channelPluginLoadIntent: "full",
      })
    : createEmptyPluginRegistry();
  if (!loadPlugins) {
    pluginRegistry.providers = providers.map((id) => ({
      pluginId: id,
      source: "synthetic",
      provider: {
        id,
        label: id,
        auth: [],
        normalizeResolvedModel: ({ model }) => ({ ...model, name: `${model.id} normalized` }),
        normalizeTransport: () => undefined,
      },
    }));
  }
  const generation: PreparedModelRuntimePluginGeneration = {
    remoteCatalog: null,
    pluginMetadataSnapshot: metadata,
    pluginRegistry,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  const authStorage = AuthStorage.inMemory();
  const facts: PreparedModelRuntimeAgentFacts = {
    input: { config, agentDir: "/synthetic/agent" },
    env: process.env,
    authStore: { version: 1, profiles: {} },
    templateAuthStorage: authStorage,
    credentials: {},
    providerIds: providers,
    configuredModelRefs: providers.flatMap((provider) =>
      models.map((modelId) => ({ provider, modelId })),
    ),
    configuredRuntimeModels: [],
    runtimeCapabilityModels: [],
    configuredGeneratedCatalogPluginIds: [],
  };
  const catalog = { entries: [], routeVariants: [] };
  const templateModelRegistry = ModelRegistry.create(authStorage, "unused:models.json", {
    config,
    modelsJsonContents: null,
    includePluginCatalogs: false,
    pluginMetadataSnapshot: metadata,
  });
  const publish = () =>
    createPreparedModelRuntimeSnapshot(
      undefined,
      facts,
      generation,
      {
        templateModelRegistry,
        modelCatalog: catalog,
        configuredRuntimeModels: [],
      },
      {
        initialAuth: { authStore: facts.authStore, authModes: {}, providerAuthLabels: new Map() },
        readUsage: (store) => store,
        isCurrent: () => true,
        withRefreshStatus: (value) => value,
        readFullModelCatalog: () => undefined,
        refreshExpiredModelCatalog: () => {},
        recheckNativeLogin: () => {},
        readPublishedModels: () => undefined,
        loadFullModelCatalog: async () => catalog,
        loadNativeModelCatalog: async () => catalog,
        loadAuth: async () => ({ authStore: facts.authStore, authModes: {}, credentials: {} }),
      },
    );
  return { config, generation, metadata, publish };
}
