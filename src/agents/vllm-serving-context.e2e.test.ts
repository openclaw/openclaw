import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
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

// Real registered provider, guarded HTTP, prepared catalog and inference policy.
// This does not exercise a GPU or claim that vLLM itself can serve this model.
afterEach(() => vi.unstubAllEnvs());

it("keeps observed serving limits through authored overrides and catalog refresh", async () => {
  const state = await createOpenClawTestState({
    label: "vllm-serving-context",
    env: { VLLM_API_KEY: "vllm-local" },
  });
  const requests: string[] = [];
  let served: number | undefined = 49_152;
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
        response.end(
          JSON.stringify({
            data: [
              ...["implicit", "upper", "lower", "prompt-cap", "other-route", "other-api"].map(
                (id) => ({ id, max_model_len: served }),
              ),
              { id: "missing", meta: { n_ctx_train: 8_192 } },
              { id: "invalid", max_model_len: "4096" },
              { id: "zero", max_model_len: 0 },
              { id: "fractional", max_model_len: 0.5 },
            ],
          }),
        );
      }),
  });
  // Discovery's production-only default is real; do not mock the provider or fetch guard.
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  const baseUrl = "http://127.0.0.1:" + server.claim.port + "/v1";
  try {
    const defaults = {
      reasoning: false,
      input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8192,
    };
    const config: OpenClawConfig = {
      plugins: { allow: ["vllm"], entries: { vllm: { enabled: true } }, slots: { memory: "none" } },
      agents: { defaults: { model: "vllm/upper", models: { "vllm/*": {} } } },
      models: {
        providers: {
          vllm: {
            api: "openai-completions",
            apiKey: "vllm-local",
            baseUrl,
            models: [
              { ...defaults, id: "upper", name: "upper", contextWindow: 131_072 },
              { ...defaults, id: "lower", name: "lower", contextWindow: 32_768 },
              {
                ...defaults,
                id: "prompt-cap",
                name: "prompt-cap",
                contextWindow: 131_072,
                contextTokens: 32_768,
              },
              {
                ...defaults,
                id: "other-route",
                name: "other-route",
                baseUrl: baseUrl + "/other",
                contextWindow: 131_072,
              },
              {
                ...defaults,
                id: "other-api",
                name: "other-api",
                api: "openai-responses",
                contextWindow: 131_072,
              },
              ...["missing", "invalid", "zero", "fractional"].map((id) =>
                Object.assign({}, defaults, { id, name: id, contextWindow: 131_072 }),
              ),
            ],
          },
        },
      },
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
    try {
      const facts = prepared.agentFacts[0]!;
      const acquire = async (cfg = config, refresh = false) => {
        const current = { ...facts, input: { ...input, config: cfg } };
        // Under Vitest on Node, this registry-less read loads the plugin through the native
        // loader, which compiles a second cold copy of core inside the 5s production deadline.
        // Discovery's own per-request timeout still bounds the HTTP probe.
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
      const budget = (catalog: Awaited<ReturnType<typeof acquire>>, id: string, cfg = config) => {
        // A request fork is the same projection used after worker publication.
        const registry = catalog.templateModelRegistry.fork(facts.templateAuthStorage);
        const resolved = resolveExplicitModelWithRegistry({
          provider: "vllm",
          modelId: id,
          cfg,
          modelRegistry: registry,
          manifestAlias: { provider: "vllm" },
        });
        if (resolved?.kind !== "resolved") {
          throw new Error("vLLM model not resolved: " + id);
        }
        const policy = resolveEmbeddedRuntimeModelPolicy({
          cfg,
          provider: "vllm",
          modelId: id,
          runtimeModel: resolved.model,
          nativeModelOwned: false,
        });
        expect(
          resolveCompactionContextTokenBudget({
            config: cfg,
            provider: "vllm",
            modelId: id,
            model: resolved.model,
          }),
        ).toBe(policy.contextTokenBudget);
        return policy;
      };
      const catalog = await acquire();
      expect(requests).toEqual(["/v1/models"]);
      for (const [id, expected] of [
        ["implicit", 49_152],
        ["upper", 49_152],
        ["lower", 32_768],
        ["prompt-cap", 32_768],
        ["other-route", 131_072],
        ["other-api", 131_072],
        ["missing", 131_072],
        ["invalid", 131_072],
        ["zero", 131_072],
        ["fractional", 131_072],
      ] as const) {
        expect(budget(catalog, id).contextTokenBudget, id).toBe(expected);
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
      expect(budget(initialPublication, "upper").contextTokenBudget).toBe(49_152);
      served = 32_768;
      const refreshed = await workerCatalog(true);
      expect(budget(refreshed, "upper").contextTokenBudget).toBe(32_768);
      expect(budget(catalog, "upper").contextTokenBudget).toBe(49_152); // Open turn stays stable.
      expect(
        refreshed.modelCatalog.entries.find((entry) => entry.id === "upper")?.contextTokens,
      ).toBe(32_768);
      served = undefined;
      const missing = await workerCatalog(true);
      expect(budget(missing, "upper").contextTokenBudget).toBe(131_072);
      const changedRoute: OpenClawConfig = {
        ...config,
        models: {
          providers: {
            vllm: {
              ...config.models!.providers!.vllm!,
              baseUrl: baseUrl + "/replacement",
            },
          },
        },
      };
      expect(budget(initialPublication, "upper", changedRoute).contextTokenBudget).toBe(131_072);
      expect(requests).toEqual(Array(4).fill("/v1/models"));
      retirement.abort();
      await closePreparedModelRuntimeSnapshots();

      const manual = { ...config, agents: { defaults: { model: "vllm/upper" } } };
      expect(budget(await acquire(manual, true), "upper", manual).contextTokenBudget).toBe(131_072);
      expect(requests).toHaveLength(4); // Explicit/manual configuration never probes.
    } finally {
      await closePreparedModelRuntimeSnapshots();
      await discardPreparedPluginGeneration(prepared.pluginGeneration);
    }
  } finally {
    server.listener.closeAllConnections();
    await server.releaseListener();
    await server.claim.release();
    await state.cleanup();
  }
});
