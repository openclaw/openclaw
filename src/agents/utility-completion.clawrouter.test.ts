import { readFile } from "node:fs/promises";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { afterEach, expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import { stripPluginModelCatalogCredentials } from "./plugin-model-catalog-repair.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";
import { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";
import {
  assertPrepared,
  completionContext,
  completionModelDefinition,
  startCompletionServer,
} from "./simple-completion.test-support.js";
import { prepareUtilityCompletionForAgent } from "./utility-completion.js";

const modelId = "openai/gpt-6-luna";
const chatModelId = "openai/gpt-6.1-sol";
const chatRow = { id: chatModelId, upstream: "gpt-6.1-sol", capabilities: ["llm.chat"] };
const baseUrl = "https://clawrouter.openclaw.ai/v1";
const unsupported = "Model clawrouter/openai/gpt-6-luna does not support chat inference";

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  vi.restoreAllMocks();
});

// External I/O only is synthetic. The bundled plugin, credential-scoped discovery,
// registry, startup/refresh catalog assembly, utility selector and chat guard are real.
it("prepares granted Luna chat and Decisions without leaking grants across credentials or routes", async () => {
  await withOpenClawTestState(
    {
      label: "clawrouter-utility",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
        CLAWROUTER_API_KEY: undefined,
      },
    },
    async (state) => {
      const fetched: string[] = [];
      const responses: Array<{
        url: string | undefined;
        authorization: string | undefined;
        body: unknown;
      }> = [];
      await using server = await startCompletionServer((request, response) => {
        void readText(request).then((body) => {
          responses.push({
            url: request.url,
            authorization: request.headers.authorization,
            body: JSON.parse(body),
          });
          writeOpenAiResponsesText(response, {
            text: "OK",
            messageId: "fixture-message",
            responseId: "fixture-response",
          });
        });
      });
      const nativeFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === baseUrl + "/responses") {
          return nativeFetch(server.baseUrl + "/responses", init);
        }
        expect(url).toBe(baseUrl + "/catalog");
        const credential = new Headers(init?.headers).get("authorization") ?? "";
        fetched.push(credential);
        const granted = credential === "Bearer synthetic-granted";
        return Response.json({
          providers: [
            {
              id: "openai",
              displayName: "OpenAI",
              openaiCompatible: granted,
              nativeBaseUrl: "/v1/native/openai",
              routes: [],
              models: [
                {
                  id: modelId,
                  upstream: "gpt-6-luna",
                  capabilities: granted
                    ? ["llm.responses", "llm.chat", "llm.decisions"]
                    : credential === "Bearer synthetic-incompatible"
                      ? ["llm.responses", "llm.decisions"]
                      : ["llm.decisions"],
                },
                ...(granted ? [chatRow] : []),
              ],
            },
          ],
        });
      });
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            utilityModel: { primary: "clawrouter/openai/gpt-6-luna", fallbacks: [] },
          },
        },
        models: {
          providers: {
            clawrouter: {
              baseUrl,
              api: "openai-responses",
              apiKey: "synthetic-granted",
              models: [],
            },
          },
        },
        plugins: {
          allow: ["clawrouter"],
          entries: { clawrouter: { enabled: true } },
          slots: { memory: "none" },
        },
      };
      await state.writeConfig(cfg);
      const settingsBefore = await readFile(state.configPath, "utf8");
      await using lease = await acquireAgentRunPreparedModelRuntime({
        config: cfg,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
      });
      const providers = await resolveRuntimePluginDiscoveryProviders({
        config: cfg,
        workspaceDir: state.workspaceDir,
        onlyPluginIds: ["clawrouter"],
        pluginMetadataSnapshot: lease.snapshot.metadataSnapshot,
      });
      const provider = providers.find((entry) => entry.id === "clawrouter" && entry.catalog);
      if (!provider) {
        throw new Error("Missing bundled ClawRouter discovery owner");
      }
      const selected = await prepareUtilityCompletionForAgent({
        cfg,
        agentId: "main",
        useUtilityModel: true,
        manifestPlugins: lease.snapshot.metadataSnapshot,
      });
      const prepare = (runtime: typeof lease.snapshot, config = cfg, model = selected.model) =>
        prepareSimpleCompletionModel({
          cfg: config,
          provider: selected.provider,
          modelId: model,
          agentId: "main",
          agentDir: state.agentDir(),
          preparedModelRuntime: runtime,
        });
      // v2026.10.7 (157d8c2bc3ea) persisted this generated-catalog shape without
      // inference. Keep its rows/settings readable, but do not invent a chat grant
      // until the normal credential-scoped discovery refresh supplies one.
      const retainedAuth = AuthStorage.inMemory({});
      const retainedRegistry = ModelRegistry.create(retainedAuth, "captured:retained-clawrouter", {
        config: cfg,
        modelsJsonContents: null,
        pluginMetadataSnapshot: lease.snapshot.metadataSnapshot,
        pluginCatalogs: [
          {
            pluginId: "clawrouter",
            contents: JSON.stringify({
              generatedBy: "openclaw-plugin-model-catalog-v1",
              providers: {
                clawrouter: {
                  baseUrl,
                  api: "openai-responses",
                  models: [
                    completionModelDefinition({
                      id: modelId,
                      name: "OpenAI · gpt-6-luna",
                      api: "openai-responses",
                      baseUrl,
                      contextWindow: 200_000,
                      maxTokens: 32_768,
                      params: { clawrouterRoute: { api: "openai-responses", baseUrl } },
                    }),
                  ],
                },
              },
            }),
          },
        ],
      });
      expect(retainedRegistry.find("clawrouter", modelId)).toMatchObject({
        id: modelId,
        contextWindow: 200_000,
        maxTokens: 32_768,
      });
      const retained = prepareCapturedRuntimeFacts({
        agentFacts: {
          input: { config: cfg },
          configuredModelRefs: [{ provider: "clawrouter", modelId }],
        },
        workspaceFacts: {
          pluginMetadataSnapshot: lease.snapshot.metadataSnapshot,
          inlineProviderModels: [],
        },
        templateModelRegistry: retainedRegistry,
        configuredRuntimeModels: [],
      });
      await expect(
        prepare({
          ...lease.snapshot,
          modelCatalog: retained.modelCatalog,
          createStores: () => ({ authStorage: retainedAuth, modelRegistry: retainedRegistry }),
        }),
      ).resolves.toMatchObject({ error: unsupported });
      expect(fetched).toEqual([]);
      for (const { key, route } of [
        { key: "synthetic-granted" },
        { key: "synthetic-decisions-only" },
        { key: "synthetic-incompatible" },
        { key: "synthetic-granted", route: { baseUrl: "https://other.fixture.invalid/v1" } },
        { key: "synthetic-granted", route: { api: "openai-completions" as const } },
        { key: "synthetic-granted", route: { baseUrl: "https://clawrouter.openclaw.ai" } },
      ]) {
        const config: OpenClawConfig = route
          ? {
              ...cfg,
              models: {
                providers: {
                  clawrouter: {
                    baseUrl,
                    api: "openai-responses",
                    apiKey: key,
                    models: [modelId, chatModelId].map((id) =>
                      completionModelDefinition({ id, ...route }),
                    ),
                  },
                },
              },
            }
          : cfg;
        const auth = {
          apiKey: key,
          discoveryApiKey: key,
          mode: "api_key" as const,
          source: "profile" as const,
        };
        const result = await runProviderCatalog({
          provider,
          config: cfg,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          env: state.env,
          resolveProviderApiKey: () => auth,
          resolveProviderAuth: () => auth,
        });
        const discovered = normalizePluginDiscoveryResult({ provider, result });
        expect(discovered.clawrouter?.models).toHaveLength(key === "synthetic-granted" ? 2 : 0);
        const contents = stripPluginModelCatalogCredentials(
          JSON.stringify({
            generatedBy: "openclaw-plugin-model-catalog-v1",
            providers: discovered,
          }),
        );
        if (contents === null) {
          throw new Error("Invalid generated fixture catalog");
        }
        const authStorage = AuthStorage.inMemory({});
        const registry = ModelRegistry.create(authStorage, "captured:clawrouter", {
          config,
          pluginMetadataSnapshot: lease.snapshot.metadataSnapshot,
          modelsJsonContents: null,
          pluginCatalogs: [{ pluginId: "clawrouter", contents }],
        });
        const captured = prepareCapturedRuntimeFacts({
          agentFacts: {
            input: { config },
            configuredModelRefs: [{ provider: "clawrouter", modelId }],
          },
          workspaceFacts: {
            pluginMetadataSnapshot: lease.snapshot.metadataSnapshot,
            inlineProviderModels: [],
          },
          templateModelRegistry: registry,
          configuredRuntimeModels: [],
        }).modelCatalog;
        const refreshed = await buildPreparedModelCatalogSnapshot({
          config,
          agentDir: state.agentDir(),
          authCredentials: {},
          models: registry.getAll(),
          metadataSnapshot: lease.snapshot.metadataSnapshot,
          includeProviderPluginAugmentation: false,
        });
        for (const catalog of [captured, refreshed]) {
          const snapshot = {
            ...lease.snapshot,
            config,
            modelCatalog: catalog,
            createStores: () => ({ authStorage, modelRegistry: registry }),
          };
          const prepared = await prepare(snapshot, config);
          if (key === "synthetic-granted" && !route) {
            expect(prepared).not.toHaveProperty("error");
            assertPrepared(prepared);
            if (catalog === captured) {
              const completed = await completeWithPreparedSimpleCompletionModel({
                model: prepared.model,
                auth: prepared.auth,
                cfg: config,
                context: completionContext("Reply with exactly OK.", 1),
                options: { reasoning: "off", maxTokens: 32 },
              });
              expect(completed.content).toContainEqual(
                expect.objectContaining({ type: "text", text: "OK" }),
              );
              expect(completed.stopReason).toBe("stop");
            }
            expect(
              catalog.entries.find(
                (entry) => entry.provider === "clawrouter" && entry.id === modelId,
              ),
            ).toMatchObject({
              inference: { chat: true, decision: { protocol: "openai-decisions" } },
            });
          } else {
            expect(prepared).toMatchObject({ error: unsupported });
          }
          // A plain chat grant survives a configured route change; only typed rows are vetoed.
          if (key === "synthetic-granted") {
            expect(await prepare(snapshot, config, chatModelId)).not.toHaveProperty("error");
          }
        }
      }
      expect(responses).toEqual([
        {
          url: "/v1/responses",
          authorization: "Bearer synthetic-granted",
          body: expect.objectContaining({ model: modelId, stream: true, max_output_tokens: 32 }),
        },
      ]);
      expect(await readFile(state.configPath, "utf8")).toBe(settingsBefore);
      expect(fetched).toEqual([
        "Bearer synthetic-granted",
        "Bearer synthetic-decisions-only",
        "Bearer synthetic-incompatible",
      ]);
    },
  );
});
