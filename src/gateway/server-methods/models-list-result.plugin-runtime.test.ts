import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { ModelsListResultSchema } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DecisionProviderCapabilities } from "../../plugins/manifest-types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerGatewayModelCatalogPrivateAccess } from "../server-model-catalog-auth.js";
import type { GatewayModelCatalogContext } from "./models-list-context.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
  prepareModelsListResult,
} from "./models-list-result.js";
import { modelsHandlers } from "./models.js";
import type { GatewayRequestContext } from "./types.js";

function catalogEntry(id: string): ModelCatalogEntry {
  return { id, name: id, provider: "custom", api: "openai-responses" };
}

function preparedMetadataSnapshot() {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "custom",
        syntheticAuthRefs: ["custom"],
        modelIdNormalization: {
          providers: {
            custom: {
              aliases: {
                legacy: "modern",
              },
            },
          },
        },
      },
    ],
  });
}

describe("models.list plugin metadata handoff", () => {
  it.each<{
    name: string;
    plugins: OpenClawConfig["plugins"];
    expected: boolean;
    provider?: string;
    chat?: boolean;
    expectedChat?: boolean;
    error?: string;
  }>([
    { name: "available", plugins: {}, expected: true },
    { name: "globally disabled", plugins: { enabled: false }, expected: false },
    {
      name: "plugin disabled",
      plugins: { entries: { decisions: { enabled: false } } },
      expected: false,
    },
    { name: "denied", plugins: { deny: ["decisions"] }, expected: false },
    { name: "decision-only provider filter", plugins: {}, provider: "fixture", expected: true },
    {
      name: "disabled decision provider filter",
      plugins: { entries: { decisions: { enabled: false } } },
      provider: "fixture",
      expected: false,
    },
    {
      name: "unknown provider filter",
      plugins: {},
      provider: "missing",
      expected: false,
      error: "Unknown model catalog provider",
    },
    {
      name: "normalized decision provider filter",
      plugins: {},
      provider: " Fixture ",
      expected: true,
    },
    {
      name: "decision provider filter with chat entries",
      plugins: {},
      provider: "fixture",
      chat: true,
      expected: true,
    },
    {
      name: "chat provider filter with decision entries",
      plugins: {},
      provider: "custom",
      chat: true,
      expectedChat: true,
      expected: false,
    },
    {
      name: "mixed catalog without a filter",
      plugins: {},
      chat: true,
      expectedChat: true,
      expected: true,
    },
  ])(
    "keeps decision discovery separate from chat routing: $name",
    async ({ plugins, expected, provider, chat, expectedChat, error }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          ...(chat ? { defaults: { model: "custom/chat", models: { "custom/chat": {} } } } : {}),
        },
        plugins,
      };
      const snapshot: ModelCatalogSnapshot = {
        entries: chat ? [catalogEntry("chat")] : [],
        routeVariants: [],
      };
      const capabilities: DecisionProviderCapabilities = {
        questionTypes: ["boolean", "choice", "score"],
        maxQuestions: 32,
        maxInputTokens: 512,
        inputTokenScope: "state-plus-each-criterion",
        confidence: "provider-specific",
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "decisions",
            contracts: { decisionProviders: ["fixture"] },
            decisionModels: [
              {
                provider: "fixture",
                id: "fast",
                name: "Fast decisions",
                capabilities,
                setup: [
                  {
                    kind: "local-model",
                    label: "Prepare model",
                    help: "Download model artifacts separately.",
                  },
                ],
              },
            ],
          },
          ...(chat ? [{ id: "custom", providers: ["custom"] }] : []),
        ],
      });
      const projector = createGatewayAgentModelCatalogProjector({
        cfg,
        agentId: "main",
        snapshot,
        metadataSnapshot,
        preparedAuthStore: { version: 1, profiles: {} },
      });
      const loadGatewayModelCatalogSnapshot = vi.fn(() => {
        throw new Error("Unexpected runtime discovery");
      });
      const context = {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalogSnapshot,
        logGateway: { debug: vi.fn() },
      } satisfies GatewayModelCatalogContext;
      const request = buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params: { view: "configured", ...(provider ? { provider } : {}) },
        preloadedCatalog: { agentId: "main", config: cfg, snapshot },
        preloadedOnly: true,
        catalogProjector: projector,
      });
      if (error) {
        await expect(request).rejects.toThrow(error);
        expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
        return;
      }
      const result = await request;
      expect(result.models.map((entry) => entry.id)).toEqual(expectedChat ? ["chat"] : []);
      expect(result.decisionModels ?? []).toEqual(
        expected
          ? [
              {
                provider: "fixture",
                id: "fast",
                name: "Fast decisions",
                pluginId: "decisions",
                readiness: "unknown",
                setup: {
                  kind: "local-model",
                  label: "Prepare model",
                  help: "Download model artifacts separately.",
                },
                capabilities,
              },
            ]
          : [],
      );
      expect(Check(ModelsListResultSchema, result)).toBe(true);
      expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    },
  );

  it("reuses one Gateway-owned metadata snapshot across startup projection and browse", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-plugin-runtime-",
        agentEnv: "main",
      },
      async (state) => {
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "custom/legacy" },
              models: {
                "custom/legacy": {},
                "custom/another": {},
              },
            },
          },
        } as OpenClawConfig;
        const snapshot: ModelCatalogSnapshot = {
          entries: [catalogEntry("modern"), catalogEntry("another")],
          routeVariants: [],
        };
        const projector = createGatewayAgentModelCatalogProjector({
          cfg,
          agentId: "main",
          snapshot,
          metadataSnapshot: preparedMetadataSnapshot(),
          preparedAuthStore: { version: 1, profiles: {} },
        });
        await projector.projectCatalog();

        let currentConfig = cfg;
        const context = {
          getRuntimeConfig: () => currentConfig,
          loadGatewayModelCatalogSnapshot: vi.fn(),
          logGateway: { debug: vi.fn() },
        } as unknown as GatewayRequestContext;
        const prepared = await prepareModelsListResult({
          source: { kind: "gateway", context },
          agentId: "main",
          params: { view: "configured" },
          preloadedCatalog: { agentId: "main", config: cfg, snapshot },
          preloadedOnly: true,
          catalogProjector: projector,
        });
        expect(
          prepared
            .read()
            .models.map((entry) => entry.id)
            .toSorted(),
        ).toEqual(["another", "modern"]);
        expect(prepared.isCurrent()).toBe(true);
        currentConfig = { ...cfg };
        expect(prepared.isCurrent()).toBe(false);
      },
    );
  });

  it("keeps prepared owner facts for wildcard preloaded-only browse", async () => {
    const cfg = {
      agents: { defaults: { models: { "custom/*": {} } } },
    } as OpenClawConfig;
    const snapshot: ModelCatalogSnapshot = { entries: [], routeVariants: [] };
    const loadGatewayModelCatalogSnapshot = vi.fn();
    const context = {
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    const projector = createGatewayAgentModelCatalogProjector({
      cfg,
      agentId: "main",
      snapshot,
      metadataSnapshot: preparedMetadataSnapshot(),
      preparedAuthStore: { version: 1, profiles: {} },
    });

    await buildModelsListResult({
      source: { kind: "gateway", context },
      params: { view: "configured" },
      preloadedCatalog: { agentId: "main", config: cfg, snapshot },
      preloadedOnly: true,
      catalogProjector: projector,
    });

    expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "uses the prepared generation registry in the normal models.list handler",
      supersedeDuringDiscovery: false,
      expectedAvailable: true,
    },
    {
      name: "reports retryable unavailability when harness discovery supersedes the prepared generation",
      supersedeDuringDiscovery: true,
      expectedAvailable: false,
    },
  ])("$name", async ({ supersedeDuringDiscovery, expectedAvailable }) => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-prepared-registry-",
        agentEnv: "main",
      },
      async (state) => {
        const runtimeId = "prepared-native";
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: "custom/native-model",
              models: {
                "custom/native-model": { agentRuntime: { id: runtimeId } },
              },
              modelPolicy: { allow: ["custom/native-model"] },
            },
          },
        } as OpenClawConfig;
        const entry: ModelCatalogEntry = {
          id: "native-model",
          name: "Native Model",
          provider: "custom",
          nativeRuntime: runtimeId,
        };
        const snapshot: ModelCatalogSnapshot = {
          entries: [entry],
          routeVariants: [entry],
        };
        let generationCurrent = true;
        const loadPreparedCatalog = vi.fn(async () => {
          if (supersedeDuringDiscovery) {
            generationCurrent = false;
          }
          return [entry];
        });
        const harness: AgentHarnessV2 = {
          id: runtimeId,
          label: "Prepared native harness",
          authBootstrap: "harness",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          loadModelCatalog: loadPreparedCatalog,
          readModelCatalogReadiness: () => ({ accountType: "chatgpt" }),
        };
        const preparedRegistry = createEmptyPluginRegistry();
        preparedRegistry.agentHarnesses.push({ pluginId: runtimeId, source: "test", harness });
        const loadActiveCatalog = vi.fn(async () => [entry]);
        const unrelatedActiveRegistry = createEmptyPluginRegistry();
        unrelatedActiveRegistry.agentHarnesses.push({
          pluginId: runtimeId,
          source: "test",
          harness: {
            ...harness,
            loadModelCatalog: loadActiveCatalog,
            readModelCatalogReadiness: () => undefined,
          },
        });
        const previousRegistry = captureActivePluginRegistrySnapshot();
        setActivePluginRegistry(unrelatedActiveRegistry);
        try {
          const preparedSnapshot = {
            ...snapshot,
            agentId: "main",
            agentDir: state.agentDir("main"),
            workspaceDir: state.workspaceDir,
            config: cfg,
            observationConfig: cfg,
            catalogComplete: true,
            authModes: {},
            authStore: { version: 1, profiles: {} },
            metadataSnapshot: preparedMetadataSnapshot(),
            authMaterializations: [],
            pluginRegistry: preparedRegistry,
            isCurrent: () => generationCurrent,
          };
          const loadGatewayModelCatalogSnapshot = vi.fn(async () => preparedSnapshot);
          registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
            loadDeferred: async () => {
              await loadPreparedCatalog();
              return preparedSnapshot;
            },
            readPrepared: async () => preparedSnapshot,
          });
          const respond = vi.fn();
          const handler = modelsHandlers["models.list"];
          if (!handler) {
            throw new Error("models.list handler missing");
          }

          const request = handler({
            req: {
              type: "req",
              id: "prepared-registry-models-list",
              method: "models.list",
              params: { agentId: "main", view: "configured", refresh: true },
            },
            params: { agentId: "main", view: "configured", refresh: true },
            respond,
            client: null,
            isWebchatConnect: () => false,
            context: {
              getRuntimeConfig: () => cfg,
              loadGatewayModelCatalogSnapshot,
              logGateway: { debug: vi.fn(), warn: vi.fn() },
            } as never,
          });

          await request;
          expect(loadPreparedCatalog).toHaveBeenCalledOnce();
          expect(loadActiveCatalog).not.toHaveBeenCalled();
          if (supersedeDuringDiscovery) {
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({
                code: "UNAVAILABLE",
                message: expect.stringContaining("Model catalog changed"),
                retryable: true,
                retryAfterMs: 0,
              }),
            );
          } else {
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              true,
              expect.objectContaining({
                models: [
                  expect.objectContaining({
                    provider: "custom",
                    id: "native-model",
                    available: expectedAvailable,
                  }),
                ],
              }),
              undefined,
            );
          }
        } finally {
          restoreActivePluginRegistrySnapshot(previousRegistry);
        }
      },
    );
  });
});
