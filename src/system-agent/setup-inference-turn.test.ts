import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../gateway/server-chat.js";
import {
  emitAgentEvent,
  onAgentEventForRun,
  type AgentEventRuntimePayload,
} from "../infra/agent-events.js";
import { clearAgentRunContext, getAgentRunContext } from "../infra/agent-run-registry.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { captureAsyncWorkTracker } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  loadSetupInferencePluginGeneration,
  revalidateStableSetupInferenceOwner,
  runSetupInferenceTurn,
} from "./setup-inference-turn.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";

const mocks = vi.hoisted(() => ({ loadAgentRuntimePluginRegistryHandle: vi.fn() }));
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));

function embeddedRoute(runtime: "codex" | "openclaw" = "codex"): SystemAgentConfiguredRoute {
  const config: OpenClawConfig = {
    agents: {
      entries: { main: { default: true, agentDir: "/tmp/openclaw-agent" } },
      defaults: {
        model: "openai/gpt-5.6-sol",
        models: { "openai/gpt-5.6-sol": { agentRuntime: { id: runtime } } },
        workspace: "/tmp/openclaw-workspace",
      },
    },
  };
  return {
    runner: "embedded",
    provider: "openai",
    model: "gpt-5.6-sol",
    modelLabel: "openai/gpt-5.6-sol",
    agentId: "main",
    agentDir: "/tmp/openclaw-agent",
    agentHarnessRuntimeOverride: runtime,
    sourceConfig: config,
    runConfig: config,
  };
}

describe("setup inference plugin ownership", () => {
  it("waits for the isolated probe runtime to release its plugin work", async () => {
    const route = embeddedRoute();
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const removeTempDir = vi.fn(async () => {});
    const runEmbeddedAgent = vi.fn(async () => {
      const trackOwner = captureAsyncWorkTracker();
      void trackOwner(async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      });
      return {
        payloads: [{ text: "OK" }],
        meta: {
          durationMs: 1,
          executionTrace: {
            winnerProvider: route.provider,
            winnerModel: route.model,
          },
        },
      };
    });

    let settled = false;
    const turn = runSetupInferenceTurn({
      route,
      deps: {
        createTempDir: async () => "/tmp/openclaw-setup-inference-test",
        removeTempDir,
        runEmbeddedAgent,
      },
      requireExecutionOwner: false,
    }).finally(() => {
      settled = true;
    });

    await cleanupStarted.promise;
    try {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(removeTempDir).not.toHaveBeenCalled();
    } finally {
      releaseCleanup.resolve();
    }
    await expect(turn).resolves.toMatchObject({ ok: true, text: "OK" });
    expect(removeTempDir).toHaveBeenCalledOnce();
  });

  it("loads newly installed package facts after the install lease cached their absence", async () => {
    await withOpenClawTestState(
      { label: "setup-plugin-generation", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const config = {
          plugins: {
            allow: ["fixture-runtime"],
            load: { paths: [state.statePath("plugin")] },
            entries: { "fixture-runtime": { enabled: true } },
          },
        };
        await withPluginCache(createPluginCache(), async () => {
          const input = { config, workspaceDir: state.workspaceDir, allowCurrent: false };
          const before = resolvePluginMetadataSnapshot(input);
          expect(before.byPluginId.has("fixture-runtime")).toBe(false);
          await state.writeJson("plugin/package.json", {
            name: "@fixture/runtime",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          });
          await state.writeJson("plugin/openclaw.plugin.json", {
            id: "fixture-runtime",
            agentHarnesses: ["fixture-runtime"],
            configSchema: { type: "object" },
          });
          await state.writeText("plugin/index.js", 'throw new Error("metadata must not execute");');
          mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValueOnce(
            createEmptyPluginRegistry(),
          );
          await using generationCache = createPluginCache();
          const generation = loadSetupInferencePluginGeneration({
            cache: generationCache,
            config,
            workspaceDir: state.workspaceDir,
            selection: { provider: "fixture", modelId: "model", runtime: "fixture-runtime" },
          });
          expect(generation.metadataSnapshot.byPluginId.has("fixture-runtime")).toBe(true);
          expect(resolvePluginMetadataSnapshot(input)).toBe(before);
        });
      },
    );
  });

  it.each([true, false])(
    "retains the probing registry artifact preference (%s)",
    async (preferBuiltPluginArtifacts) => {
      const order: string[] = [];
      const pluginRegistry = createEmptyPluginRegistry();
      const route = embeddedRoute();
      const { binding } = await createSystemAgentVerifiedInferenceTestFixture(route.sourceConfig);
      const metadataSnapshot = createPluginMetadataSnapshot({
        config: route.runConfig,
        manifestRegistry: makeRegistry([]),
        workspaceDir: "/tmp/openclaw-workspace",
      });
      const probingRegistry = createEmptyPluginRegistry();
      setPluginRuntimeLoadContext(
        probingRegistry,
        resolvePluginRuntimeLoadContext({
          config: route.runConfig,
          metadataSnapshot,
          preferBuiltPluginArtifacts,
        }),
      );
      const previousMetadata = getCurrentPluginMetadataSnapshot();
      const resolveMetadataSnapshot = vi.fn(() => {
        order.push("metadata");
        return metadataSnapshot;
      });
      mocks.loadAgentRuntimePluginRegistryHandle.mockImplementationOnce(() => {
        order.push("load");
        expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
        return pluginRegistry;
      });
      const createSystemAgentVerifiedInferenceBinding = vi.fn(async () => {
        order.push("validate");
        expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
        return binding;
      });

      await withPluginRuntimeRegistryScope(probingRegistry, async () => {
        await expect(
          revalidateStableSetupInferenceOwner({
            route,
            auth: {
              agentHarnessId: "codex",
              runtimeOwnerKind: "plugin-harness",
            },
            stagedOwnerPluginArtifacts: binding,
            deps: {
              createSystemAgentVerifiedInferenceBinding,
              resolvePluginMetadataSnapshot: resolveMetadataSnapshot,
            },
          }),
        ).resolves.toBe(binding);
      });

      expect(order).toEqual(["metadata", "load", "validate"]);
      expect(getCurrentPluginMetadataSnapshot()).toBe(previousMetadata);
      expect(resolveMetadataSnapshot).toHaveBeenCalledWith({
        config: route.runConfig,
        env: process.env,
        workspaceDir: "/tmp/openclaw-workspace",
        allowCurrent: false,
      });
      expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith({
        config: route.runConfig,
        metadataSnapshot,
        preferBuiltPluginArtifacts,
        workspaceDir: "/tmp/openclaw-workspace",
        selections: [
          { provider: "openai", modelId: "gpt-5.6-sol", runtime: "codex", agentId: "main" },
        ],
      });
    },
  );

  it("does not load plugins for a direct custom provider using the built-in OpenClaw harness", async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: { main: { default: true, agentDir: "/tmp/openclaw-agent" } },
        defaults: {
          model: "fixture/direct-model",
          models: { "fixture/direct-model": { agentRuntime: { id: "openclaw" } } },
          workspace: "/tmp/openclaw-workspace",
        },
      },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://provider.example/v1",
            models: [],
          },
        },
      },
    };
    const { binding } = await createSystemAgentVerifiedInferenceTestFixture(config);
    expect(binding.ownerPluginIds).toEqual([]);
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();

    await expect(
      revalidateStableSetupInferenceOwner({
        route: binding.execution,
        auth: binding.auth,
        stagedOwnerPluginArtifacts: binding,
        deps: {
          createSystemAgentVerifiedInferenceBinding: vi.fn(async () => binding),
        },
      }),
    ).resolves.toBe(binding);

    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  });
});

describe("setup probe projection", () => {
  it.each(["end", "error"] as const)(
    "keeps a completed probe out of Gateway projection (%s)",
    async (phase) => {
      const route = embeddedRoute("openclaw");
      const events: AgentEventRuntimePayload[] = [];
      const broadcast = vi.fn();
      const broadcastToConnIds = vi.fn();
      const nodeSendToSession = vi.fn();
      const persistLifecycle = vi.fn(async () => undefined);
      const chatRunState = createChatRunState();
      const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
      const handler = createAgentEventHandler({
        broadcast,
        broadcastToConnIds,
        nodeSendToSession,
        nodeHasSessionSubscribers: () => false,
        agentRunSeq: new Map(),
        chatRunState,
        resolveSessionKeyForRun: () => undefined,
        clearAgentRunContext,
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers,
        persistGatewaySessionLifecycleEventForEvent: persistLifecycle,
        lifecycleErrorRetryGraceMs: 0,
      });
      let runId: string | undefined;
      let unsubscribe = () => {};
      try {
        const result = await runSetupInferenceTurn({
          route,
          requireExecutionOwner: false,
          deps: {
            runEmbeddedAgent: async (params) => {
              runId = params.runId;
              unsubscribe = onAgentEventForRun(params.runId, (event) => events.push(event));
              sessionMessageSubscribers.subscribe("probe-viewer", params.sessionKey!);
              emitAgentEvent({
                runId: params.runId,
                sessionKey: params.sessionKey,
                stream: "assistant",
                data: { text: "Internal setup response" },
              });
              emitAgentEvent({
                runId: params.runId,
                sessionKey: params.sessionKey,
                stream: "lifecycle",
                data: {
                  phase,
                  executionSettled: true,
                  ...(phase === "error" ? { error: "provider refused probe" } : {}),
                },
              });
              if (phase === "error") {
                throw new Error("provider refused probe");
              }
              return {
                meta: {
                  durationMs: 1,
                  finalAssistantVisibleText: "Internal setup response",
                  executionTrace: { winnerProvider: route.provider, winnerModel: route.model },
                },
              };
            },
          },
        });
        expect(result).toMatchObject(
          phase === "end"
            ? { ok: true, text: "Internal setup response" }
            : { ok: false, error: expect.stringContaining("provider refused probe") },
        );
        expect(runId).toBeDefined();
        expect(getAgentRunContext(runId!)).toBeUndefined();

        // Gateway delivery can consume retained events after the producer has cleaned up.
        for (const event of events) {
          handler(event);
        }
        expect(broadcast).not.toHaveBeenCalled();
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(nodeSendToSession).not.toHaveBeenCalled();
        expect(persistLifecycle).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        handler.dispose();
        chatRunState.clear();
        if (runId) {
          clearAgentRunContext(runId);
        }
      }
    },
  );
});
