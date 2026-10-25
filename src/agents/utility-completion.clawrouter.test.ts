import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";
import { completionModelDefinition } from "./simple-completion.test-support.js";
import { prepareUtilityCompletionForAgent } from "./utility-completion.js";

const modelId = "openai/gpt-6-luna";
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
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        expect(input instanceof Request ? input.url : input.toString()).toBe(baseUrl + "/catalog");
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
      expect(provider).toBeDefined();
      if (!provider) {
        throw new Error("Missing bundled ClawRouter discovery owner");
      }
      const selected = await prepareUtilityCompletionForAgent({
        cfg,
        agentId: "main",
        useUtilityModel: true,
        manifestPlugins: lease.snapshot.metadataSnapshot,
      });
      for (const { key, route } of [
        { key: "synthetic-granted" },
        { key: "synthetic-decisions-only" },
        { key: "synthetic-incompatible" },
        { key: "synthetic-granted", route: { baseUrl: "https://other.fixture.invalid/v1" } },
        { key: "synthetic-granted", route: { api: "openai-completions" as const } },
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
                    models: [completionModelDefinition({ id: modelId, ...route })],
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
        expect(discovered.clawrouter?.models).toHaveLength(key === "synthetic-granted" ? 1 : 0);
        const authStorage = AuthStorage.inMemory({});
        const registry = ModelRegistry.create(authStorage, "captured:clawrouter", {
          config,
          includePluginCatalogs: false,
          pluginMetadataSnapshot: lease.snapshot.metadataSnapshot,
          modelsJsonContents: JSON.stringify({ providers: discovered }),
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
          const prepared = await prepareSimpleCompletionModel({
            cfg: config,
            provider: selected.provider,
            modelId: selected.model,
            agentId: "main",
            agentDir: state.agentDir(),
            preparedModelRuntime: snapshot,
          });
          if (key === "synthetic-granted" && !route) {
            expect(prepared).not.toHaveProperty("error");
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
        }
      }
      expect(fetched).toEqual([
        "Bearer synthetic-granted",
        "Bearer synthetic-decisions-only",
        "Bearer synthetic-incompatible",
      ]);
    },
  );
});
