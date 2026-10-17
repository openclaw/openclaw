import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  type ModelsListResult,
  ModelsListResultSchema,
} from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import { createModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
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
import {
  type PreparedGatewayModelCatalogSnapshot,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { prepareModelsListResult } from "./models-list-result.js";
import {
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";
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
        modelIdNormalization: { providers: { custom: { aliases: { legacy: "modern" } } } },
      },
    ],
  });
}

const CLAUDE_MODEL = "anthropic/claude-opus-5";
const claudeModels = () => ({ [CLAUDE_MODEL]: { agentRuntime: { id: "claude-cli" } } });

function preparedCatalog(
  config: OpenClawConfig,
  snapshot: ModelCatalogSnapshot,
  overrides: Partial<PreparedGatewayModelCatalogSnapshot> = {},
): PreparedGatewayModelCatalogSnapshot {
  return {
    ...snapshot,
    config,
    observationConfig: config,
    agentId: "main",
    agentDir: "/tmp/models-list-provider-agent",
    workspaceDir: "/tmp/models-list-provider-workspace",
    catalogComplete: true,
    authModes: {},
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: preparedMetadataSnapshot(),
    authMaterializations: [],
    isCurrent: () => true,
    ...overrides,
  };
}

function withState(run: Parameters<typeof withOpenClawTestState>[1]) {
  return withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-models-list-plugin-runtime-", agentEnv: "main" },
    run,
  );
}

async function withClaudeRegistry(
  run: (
    list: (params: Parameters<typeof listModels>[0]) => ReturnType<typeof listModels>,
  ) => Promise<void>,
) {
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.cliBackends.push({
    pluginId: "anthropic",
    source: "test",
    backend: { id: "claude-cli", modelProvider: "anthropic", config: { command: "claude" } },
  });
  const previous = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
  try {
    await run((params) =>
      listModels({
        staticEntries: [providerCatalogEntry("anthropic", "claude-opus-5")],
        preparedAuthModes: { "claude-cli": "oauth" },
        catalogComplete: true,
        pluginRegistry,
        view: "configured",
        includeDefaultModels: false,
        ...params,
      }),
    );
  } finally {
    restoreActivePluginRegistrySnapshot(previous);
  }
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
    { name: "globally disabled", plugins: { enabled: false }, expected: false },
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
    async ({ plugins, expected, provider, chat = false, expectedChat = false, error }) => {
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
      const decision = { provider: "fixture", id: "fast", name: "Fast decisions", capabilities };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "decisions",
            contracts: { decisionProviders: ["fixture"] },
            decisionModels: [decision],
          },
          ...(chat ? [{ id: "custom", providers: ["custom"] }] : []),
        ],
      });
      const preparedSnapshot = preparedCatalog(cfg, snapshot, { metadataSnapshot });
      const loadGatewayModelCatalogSnapshot = vi.fn(() => {
        throw new Error("Unexpected runtime discovery");
      });
      registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
        readPrepared: async () => preparedSnapshot,
        loadDeferred: loadGatewayModelCatalogSnapshot,
      });
      const context = createGatewayRequestContext(
        makeContextParams({ loadGatewayModelCatalogSnapshot }),
      );
      context.getRuntimeConfig = () => cfg;
      context.getCommittedRuntimeConfig = () => cfg;
      context.logGateway.debug = vi.fn();
      const params = { view: "configured", ...(provider ? { provider } : {}) };
      const respond = vi.fn();
      await modelsHandlers["models.list"]!({
        req: { type: "req", id: "provider-filter", method: "models.list", params },
        params,
        respond,
        client: null,
        isWebchatConnect: () => false,
        context,
      });
      if (error) {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            message: expect.stringContaining('Unknown model catalog provider "missing"'),
          }),
        );
        expect(respond.mock.calls[0]?.[2]?.message).toContain("openclaw models list --all");
        expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
        return;
      }
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.anything(), undefined);
      const result = respond.mock.calls[0]?.[1] as ModelsListResult;
      expect(result.models.map((entry) => entry.id)).toEqual(expectedChat ? ["chat"] : []);
      expect(result.decisionModels ?? []).toEqual(
        expected ? [{ ...decision, pluginId: "decisions" }] : [],
      );
      expect(Check(ModelsListResultSchema, result)).toBe(true);
      expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    },
  );

  it("reuses one Gateway-owned metadata snapshot across startup projection and browse", async () => {
    await withState(async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "custom/legacy" },
            models: { "custom/legacy": {}, "custom/another": {} },
          },
        },
      };
      const snapshot: ModelCatalogSnapshot = {
        entries: [catalogEntry("modern"), catalogEntry("another")],
        routeVariants: [],
      };
      const projector = createModelCatalogDecisions({
        cfg,
        agentId: "main",
        snapshot,
        metadataSnapshot: preparedMetadataSnapshot(),
        preparedAuthStore: { version: 1, profiles: {} },
      });
      await projector.projectCatalog();

      const context = {
        getRuntimeConfig: () => cfg,
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
      const ids = prepared
        .read()
        .models.map((entry) => entry.id)
        .toSorted();
      expect(ids).toEqual(["another", "modern"]);
      expect(prepared.isCurrent()).toBe(true);
    });
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
    await withState(async (state) => {
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
        const preparedSnapshot = preparedCatalog(cfg, snapshot, {
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          pluginRegistry: preparedRegistry,
          isCurrent: () => generationCurrent,
        });
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

        const params = { agentId: "main", view: "configured", refresh: true };
        await handler({
          req: {
            type: "req",
            id: "prepared-registry-models-list",
            method: "models.list",
            params,
          },
          params,
          respond,
          client: null,
          isWebchatConnect: () => false,
          context: {
            getRuntimeConfig: () => cfg,
            loadGatewayModelCatalogSnapshot,
            logGateway: { debug: vi.fn(), warn: vi.fn() },
          } as never,
        });

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
    });
  });

  it("projects a prepared owner's Claude CLI route with that owner's plugin registry", async () => {
    await withClaudeRegistry(async (list) => {
      const result = await list({
        catalog: [providerCatalogEntry("claude-cli", "claude-opus-5")],
        cfg: { agents: { defaults: { model: { primary: CLAUDE_MODEL }, models: claudeModels() } } },
      });
      expect(
        result.models.map((model) => [
          `${model.provider}/${model.id}`,
          model.agentRuntime?.id,
          model.available,
        ]),
      ).toEqual([["anthropic/claude-opus-5", "claude-cli", true]]);
    });
  });

  it.each([
    { view: "configured", cliOnly: undefined },
    { view: "default", cliOnly: undefined },
    // A role or manual model policy that allows only Claude CLI refs keeps the twin.
    { view: "configured", cliOnly: "role" },
    { view: "configured", cliOnly: "agent" },
  ] as const)(
    "lists a Claude CLI model once when only the prepared owner's registry has Claude CLI ($view, cliOnly=$cliOnly)",
    async ({ view, cliOnly }) => {
      await withClaudeRegistry(async (list) => {
        const result = await list({
          catalog: [
            providerCatalogEntry("claude-cli", "claude-opus-5"),
            providerCatalogEntry("claude-cli", "claude-haiku-4-5"),
          ],
          cfg: {
            agents: {
              defaults: {
                model: { primary: CLAUDE_MODEL },
                ...(cliOnly === "agent" ? { modelPolicy: { allow: ["claude-cli/*"] } } : {}),
              },
              entries: { main: { models: claudeModels() } },
            },
            ...(cliOnly === "role"
              ? {
                  gateway: {
                    roles: {
                      default: "cli",
                      definitions: {
                        cli: {
                          agents: ["main"],
                          scopes: ["operator.read"],
                          sessions: { others: "none" },
                          modelPolicy: { allow: ["claude-cli/*"] },
                        },
                      },
                    },
                  },
                }
              : {}),
          },
          view,
        });
        expect(
          result.models.map((model) => [`${model.provider}/${model.id}`, model.agentRuntime?.id]),
        ).toEqual([
          ["anthropic/claude-opus-5", "claude-cli"],
          ["claude-cli/claude-haiku-4-5", "claude-cli"],
          ...(cliOnly ? [["claude-cli/claude-opus-5", "claude-cli"]] : []),
        ]);
      });
    },
  );

  it("reads a prepared owner's Claude CLI runtime choice with that owner's plugin registry", async () => {
    await withClaudeRegistry(async (list) => {
      const result = await list({
        catalog: [providerCatalogEntry("claude-cli", "claude-opus-5")],
        cfg: {
          agents: {
            defaults: {
              model: { primary: CLAUDE_MODEL },
              models: {
                [CLAUDE_MODEL]: {
                  agentRuntime: { id: "openclaw" },
                  pickerRuntimes: ["openclaw", "claude-cli"],
                },
              },
            },
          },
        },
      });
      expect(
        result.models[0]?.runtimeChoices?.map((choice) => [
          choice.agentRuntime.id,
          choice.available,
        ]),
      ).toEqual([["claude-cli", true]]);
    });
  });
});
