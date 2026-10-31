import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { resolveCompactionContextTokenBudget } from "./embedded-agent-runner/compaction-runtime-context.js";
import { resolveExplicitModelWithRegistry } from "./embedded-agent-runner/model.registry-resolution.js";
import { resolveEmbeddedRuntimeModelPolicy } from "./embedded-agent-runner/run/setup.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { prepareFullCatalogFacts } from "./prepared-model-runtime.full-catalog.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { discardPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { prepareAgentCatalogSource } from "./prepared-model-runtime.scoped-catalog.js";

type ModelCase = [
  id: string,
  expected: number,
  config?: Partial<ModelDefinitionConfig>,
  response?: Record<string, unknown>,
];

function model(id: string, overrides: Partial<ModelDefinitionConfig> = {}): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 8192,
    contextWindow: 131_072,
    ...overrides,
  };
}

// Real provider/HTTP/catalog policy; no GPU or vLLM serving claim.
afterEach(() => vi.unstubAllEnvs());

it("keeps observed serving limits through authored overrides and catalog refresh", async () => {
  const state = await createOpenClawTestState({
    label: "vllm-serving-context",
    env: { VLLM_API_KEY: "vllm-local" },
  });
  const requests: string[] = [];
  let served: number | undefined = 49_152;
  let cases: ModelCase[] = [];
  const server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requests.push(request.url ?? "");
        if (request.url !== "/v1/models") {
          response.writeHead(404).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        const data = cases.map((entry) => ({
          id: entry[0],
          ...(entry[3] ?? { max_model_len: served }),
        }));
        response.end(JSON.stringify({ data }));
      }),
  });
  // Discovery's production-only default is real; do not mock the provider or fetch guard.
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  const baseUrl = "http://127.0.0.1:" + server.claim.port + "/v1";
  cases = [
    ["implicit", 49_152],
    ["upper", 49_152],
    ["lower", 32_768, { contextWindow: 32_768 }],
    ["prompt-cap", 32_768, { contextTokens: 32_768 }],
    ["other-route", 131_072, { baseUrl: baseUrl + "/other" }],
    ["other-api", 131_072, { api: "openai-responses" }],
    ["missing", 131_072, undefined, { meta: { n_ctx_train: 8_192 } }],
    ["invalid", 131_072, undefined, { max_model_len: "4096" }],
    ["zero", 131_072, undefined, { max_model_len: 0 }],
    ["fractional", 131_072, undefined, { max_model_len: 0.5 }],
  ];
  let cleanupPrepared: (() => Promise<void>) | undefined;
  try {
    const vllm = {
      api: "openai-completions" as const,
      apiKey: "vllm-local",
      baseUrl,
      models: cases.filter(([id]) => id !== "implicit").map(([id, , config]) => model(id, config)),
    };
    const config: OpenClawConfig = {
      plugins: { allow: ["vllm"], entries: { vllm: { enabled: true } }, slots: { memory: "none" } },
      agents: { defaults: { model: "vllm/upper", models: { "vllm/*": {} } } },
      models: { providers: { vllm } },
    };
    const input = {
      config,
      agentId: "default",
      agentDir: state.agentDir("default"),
      workspaceDir: state.workspaceDir,
      env: { ...state.env, VITEST: "", NODE_ENV: "production" },
      skipCredentials: true,
      readOnly: true,
    };
    const prepared = await prepareWorkspaceBuildGroup([input], "static", {
      preferBuiltPluginArtifacts: true,
    });
    cleanupPrepared = async () => {
      await closePreparedModelRuntimeSnapshots();
      await discardPreparedPluginGeneration(prepared.pluginGeneration);
    };
    const facts = prepared.agentFacts[0]!;
    const acquire = async (cfg = config, refresh = false) => {
      const current = { ...facts, input: { ...input, config: cfg } };
      // The native plugin loader compiles a cold core copy; HTTP discovery stays bounded.
      const source = await prepareAgentCatalogSource(
        current,
        prepared.pluginGeneration,
        "live",
        false,
        { refresh, providerDiscoveryTimeoutMs: 60_000 },
      );
      return prepareFullCatalogFacts(current, prepared.pluginGeneration, "live", source, {
        includeNative: false,
      });
    };
    type Catalog = Awaited<ReturnType<typeof acquire>>;
    const budget = (catalog: Catalog, id: string, cfg = config) => {
      // A request fork is the same projection used after worker publication.
      const registry = catalog.templateModelRegistry.fork(facts.templateAuthStorage);
      const selection = { provider: "vllm", modelId: id };
      const resolved = resolveExplicitModelWithRegistry({
        ...selection,
        cfg,
        modelRegistry: registry,
        manifestAlias: { provider: "vllm" },
      });
      if (resolved?.kind !== "resolved") {
        throw new Error("vLLM model not resolved: " + id);
      }
      const policy = resolveEmbeddedRuntimeModelPolicy({
        ...selection,
        cfg,
        runtimeModel: resolved.model,
        nativeModelOwned: false,
      });
      expect(
        resolveCompactionContextTokenBudget({
          config: cfg,
          ...selection,
          model: resolved.model,
        }),
      ).toBe(policy.contextTokenBudget);
      return policy;
    };
    const expectBudget = (catalog: Catalog, id: string, tokens: number, cfg = config) =>
      expect(budget(catalog, id, cfg).contextTokenBudget, id).toBe(tokens);
    const catalog = await acquire();
    expect(requests).toEqual(["/v1/models"]);
    for (const [id, expected] of cases) {
      expectBudget(catalog, id, expected);
    }
    expect(budget(catalog, "upper").effectiveModel.contextWindow).toBe(49_152);
    expect(budget(catalog, "upper").contextTokensSource).toBeUndefined();
    expect(requests).toHaveLength(1); // Repeated inference consumes prepared facts only.

    const retirement = new AbortController();
    const worker = createPreparedModelCatalogWorker({
      agentFacts: facts,
      preferBuiltPluginArtifacts: true,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      isCurrent: () => !retirement.signal.aborted,
      retirementSignal: retirement.signal,
    });
    const workerCatalog = async (refresh: boolean) => {
      const publication = await worker.loadCatalog(["vllm"], undefined, refresh);
      return {
        ...catalog,
        modelCatalog: publication.modelCatalog,
        templateModelRegistry: catalog.templateModelRegistry.fork(
          facts.templateAuthStorage,
          publication.runtimeModels,
        ),
      };
    };
    const initialPublication = await workerCatalog(false);
    expectBudget(initialPublication, "upper", 49_152);
    served = 32_768;
    const refreshed = await workerCatalog(true);
    expectBudget(refreshed, "upper", 32_768);
    expectBudget(catalog, "upper", 49_152); // Open turn stays stable.
    expect(
      refreshed.modelCatalog.entries.find((entry) => entry.id === "upper")?.contextTokens,
    ).toBe(32_768);
    served = undefined;
    const missing = await workerCatalog(true);
    expectBudget(missing, "upper", 131_072);
    const changedRoute: OpenClawConfig = {
      ...config,
      models: { providers: { vllm: { ...vllm, baseUrl: baseUrl + "/replacement" } } },
    };
    expectBudget(initialPublication, "upper", 131_072, changedRoute);
    expect(requests).toEqual(Array(4).fill("/v1/models"));
    retirement.abort();
    await closePreparedModelRuntimeSnapshots();

    const manual = { ...config, agents: { defaults: { model: "vllm/upper" } } };
    expectBudget(await acquire(manual, true), "upper", 131_072, manual);
    expect(requests).toHaveLength(4); // Explicit/manual configuration never probes.
  } finally {
    try {
      await cleanupPrepared?.();
    } finally {
      server.listener.closeAllConnections();
      await server.releaseListener();
      await server.claim.release();
      await state.cleanup();
    }
  }
});
