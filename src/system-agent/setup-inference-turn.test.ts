import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { FailoverError } from "../agents/failover-error.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { resolveAgentHarnessSelectionDecision } from "../agents/harness/selection-decision.js";
import * as modelAuth from "../agents/model-auth.js";
import { createFixtureProviderModels } from "../agents/test-helpers/model-fallback-config-fixture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAgentEventTestHarness } from "../gateway/server-chat.agent-events.test-harness.js";
import {
  emitAgentEvent,
  onAgentEventForRun,
  type AgentEventRuntimePayload,
} from "../infra/agent-events.js";
import { clearAgentRunContext, getAgentRunContext } from "../infra/agent-run-registry.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import type { RuntimeEnv } from "../runtime.js";
import { captureAsyncWorkTracker } from "../shared/async-work-scope.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  loadSetupInferencePluginGeneration,
  revalidateStableSetupInferenceOwner,
  runSetupInferenceTurn,
  verifySetupInferenceConfig,
} from "./setup-inference-turn.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";
import * as verifiedInference from "./verified-inference.js";

// mock-isolation: Setup probes replace model I/O without loading the embedded runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

const mocks = vi.hoisted(() => ({ loadAgentRuntimePluginRegistryHandle: vi.fn() }));
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));

afterEach(() => vi.restoreAllMocks());

function embeddedRoute(
  runtime: "codex" | "openclaw" = "codex",
  provider = "openai",
  model = "gpt-5.6-sol",
): SystemAgentConfiguredRoute {
  const modelLabel = `${provider}/${model}`;
  const config: OpenClawConfig = {
    agents: {
      entries: { main: { agentDir: "/tmp/openclaw-agent" } },
      defaults: {
        model: modelLabel,
        models: { [modelLabel]: { agentRuntime: { id: runtime } } },
        workspace: "/tmp/openclaw-workspace",
      },
    },
  };
  return {
    runner: "embedded",
    provider,
    model,
    modelLabel,
    agentId: "main",
    agentDir: "/tmp/openclaw-agent",
    agentHarnessRuntimeOverride: runtime,
    sourceConfig: config,
    runConfig: config,
  };
}

const runProbe = (route: SystemAgentConfiguredRoute) =>
  runSetupInferenceTurn({ route, requireExecutionOwner: false });

function probeReply(route: SystemAgentConfiguredRoute, text?: string) {
  return {
    ...(text ? {} : { payloads: [{ text: "OK" }] }),
    meta: {
      durationMs: 1,
      ...(text ? { finalAssistantVisibleText: text } : {}),
      executionTrace: { winnerProvider: route.provider, winnerModel: route.model },
    },
  };
}

function revalidateOwner(
  binding: Awaited<ReturnType<typeof createSystemAgentVerifiedInferenceTestFixture>>["binding"],
  createBinding = vi.fn(async () => binding),
  route: Parameters<typeof revalidateStableSetupInferenceOwner>[0]["route"] = binding.execution,
  auth: Parameters<typeof revalidateStableSetupInferenceOwner>[0]["auth"] = binding.auth,
) {
  vi.spyOn(verifiedInference, "createSystemAgentVerifiedInferenceBinding").mockImplementation(
    createBinding,
  );
  return revalidateStableSetupInferenceOwner({
    route,
    auth,
    stagedOwnerPluginArtifacts: binding,
  });
}

describe("setup inference plugin ownership", () => {
  it.each([
    { cold: false, fallback: undefined, change: undefined },
    { cold: true, fallback: undefined, change: undefined },
    { cold: false, fallback: "unsupported", change: undefined },
    { cold: false, fallback: "unavailable", change: undefined },
    { cold: false, fallback: undefined, change: "owner" },
    { cold: false, fallback: undefined, change: "bytes" },
  ] as const)(
    "binds actual runtime selection (cold=$cold, fallback=$fallback, change=$change)",
    ({ cold, fallback, change }) =>
      withOpenClawTestState({ label: "setup-runtime-owner" }, async (state) => {
        const modelRef = "openai/gpt-6-astra";
        const manifest = {
          id: "codex",
          activation: { onAgentHarnesses: ["codex"] },
          configSchema: { type: "object" },
        };
        await state.writeJson("runtime/package.json", {
          name: "@fixture/codex",
          version: "1.0.0",
          openclaw: { extensions: ["./index.js"] },
        });
        await state.writeJson("runtime/openclaw.plugin.json", manifest);
        await state.writeText("runtime/index.js", "export const revision = 1;");
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
            defaults: { model: modelRef },
          },
          plugins: {
            allow: ["openai", "codex", "codex-replacement"],
            load: { paths: [state.statePath("runtime")] },
            entries: { codex: { enabled: true }, "codex-replacement": { enabled: true } },
          },
        };
        const createRegistry = (ownerPluginId: string) => {
          const registry = createEmptyPluginRegistry();
          if (fallback === "unavailable") {
            return registry;
          }
          registry.agentHarnesses.push({
            pluginId: ownerPluginId,
            source: state.statePath("runtime/index.js"),
            harness: {
              id: "codex",
              label: "Codex fixture",
              supports: () =>
                fallback === "unsupported"
                  ? { supported: false, reason: "Fixture route is unsupported" }
                  : { supported: true },
              runAttempt: async () => {
                throw new Error("Model I/O is replaced by the probe fixture");
              },
              runtimeArtifact: {
                validate: async (artifact) =>
                  artifact.id === "fixture-runtime" &&
                  artifact.fingerprint === "fixture-runtime-v1",
              },
            },
          });
          return registry;
        };
        const metadataSnapshot = resolvePluginMetadataSnapshot({
          config,
          workspaceDir: state.workspaceDir,
          allowCurrent: false,
        });
        expect(metadataSnapshot.byPluginId.get("codex")?.rootDir).toBe(state.statePath("runtime"));
        const resolvedAuth = {
          apiKey: "synthetic-key",
          source: "fixture",
          mode: "api-key" as const,
        };
        vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockResolvedValue(resolvedAuth);
        mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(
          ({ metadataSnapshot: preparedMetadata }: { metadataSnapshot: PluginMetadataSnapshot }) =>
            createRegistry(
              preparedMetadata.byPluginId.has("codex-replacement") ? "codex-replacement" : "codex",
            ),
        );
        await withPluginRuntimeGenerationScope(
          {
            metadataSnapshot,
            pluginRegistry: cold ? createEmptyPluginRegistry() : createRegistry("codex"),
          },
          async () => {
            expect(
              resolveAgentHarnessPolicy({
                provider: "openai",
                modelId: "gpt-6-astra",
                config,
                agentId: "main",
              }),
            ).toMatchObject({ runtime: "codex", runtimeSource: "implicit" });
            const capture = vi.spyOn(verifiedInference, "captureSystemAgentOwnerPluginArtifacts");
            const run = vi
              .spyOn(embeddedAgent, "runEmbeddedAgent")
              .mockClear()
              .mockImplementation(async (params) => {
                const selection = resolveAgentHarnessSelectionDecision({
                  provider: params.provider!,
                  modelId: params.model,
                  config: params.config,
                  agentId: params.agentId,
                  agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
                });
                expect(params.agentHarnessRuntimeOverride).toBeUndefined();
                expect(selection.selectedHarnessId).toBe(fallback ? "openclaw" : "codex");
                params.onSuccessfulAuthBinding?.({
                  agentHarnessId: selection.selectedHarnessId,
                  authFingerprint: fingerprintResolvedProviderAuth(resolvedAuth),
                  modelId: params.model,
                  modelApi: "openai-responses",
                  ...(selection.builtIn
                    ? {}
                    : {
                        runtimeOwnerKind: "plugin-harness" as const,
                        runtimeOwnerId: selection.selectedHarnessId,
                        runtimeArtifactId: "fixture-runtime",
                        runtimeArtifactFingerprint: "fixture-runtime-v1",
                      }),
                });
                if (change === "owner") {
                  await state.writeJson("runtime/openclaw.plugin.json", {
                    ...manifest,
                    id: "codex-replacement",
                  });
                } else if (change === "bytes") {
                  await state.writeText("runtime/index.js", "export const revision = 2;");
                }
                return {
                  payloads: [{ text: "OK" }],
                  meta: {
                    durationMs: 1,
                    executionTrace: { winnerProvider: params.provider, winnerModel: params.model },
                  },
                };
              });
            const onVerifiedExecution = vi.fn();
            const result = await verifySetupInferenceConfig({
              config,
              agentId: "main",
              runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
              onVerifiedExecution,
            });
            expect(run).toHaveBeenCalledOnce();
            const ownerPluginIds = fallback ? ["openai"] : ["codex", "openai"];
            expect(capture.mock.results[0]?.value).toMatchObject({ ownerPluginIds });
            if (change) {
              expect(result).toMatchObject({
                ok: false,
                status: "auth",
                error: expect.stringContaining("owner plugin runtime changed"),
              });
              expect(onVerifiedExecution).not.toHaveBeenCalled();
            } else {
              expect(result, result.ok ? undefined : result.error).toMatchObject({
                ok: true,
                modelRef,
              });
              expect(onVerifiedExecution).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ ownerPluginIds }),
              );
            }
          },
        );
      }),
  );

  it("runs an uncapped read-only probe with a detached transcript", async () => {
    const route = embeddedRoute("openclaw");
    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async (params) => {
      expect(params).toMatchObject({
        sessionPersistence: "detached",
        authProfileStateMode: "read-only",
        preparedModelRuntimeMode: "isolated-read-only",
        allowAuthProfileFallback: false,
        disableTools: true,
        thinkLevel: "off",
      });
      // Reasoning models spend a small cap on thinking; the check sends chat's limits.
      expect(params.streamParams?.maxTokens).toBeUndefined();
      return probeReply(route);
    });
    const result = await runProbe(route);
    expect(result, result.ok ? undefined : result.error).toMatchObject({
      ok: true,
      text: "OK",
    });
  });

  it.each([
    [8_192, true, true],
    [16_384, true, false],
    [8_192, undefined, false],
  ] as const)(
    "verifies a %i-token runtime context and warns only a chosen small model (candidate: %s)",
    async (contextTokens, candidateSetup, warned) => {
      const config = embeddedRoute("openclaw", "fixture", "direct-model").runConfig;
      config.models = createFixtureProviderModels("http://127.0.0.1:18299/v1");
      vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async (params) => ({
        payloads: [{ text: "OK" }],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: params.sessionId,
            provider: params.provider ?? "fixture",
            model: params.model ?? "direct-model",
            contextTokens,
          },
          executionTrace: { winnerProvider: params.provider, winnerModel: params.model },
        },
      }));
      const result = await verifySetupInferenceConfig({
        config,
        agentId: "main",
        runtime: {
          log: vi.fn<RuntimeEnv["log"]>(),
          error: vi.fn<RuntimeEnv["error"]>(),
          exit: vi.fn<RuntimeEnv["exit"]>(),
        },
        ...(candidateSetup ? { candidateSetup } : {}),
      });
      expect(result.ok, result.ok ? undefined : result.error).toBe(true);
      if (!result.ok) {
        return;
      }
      if (warned) {
        expect(result.warning).toContain(
          "fixture/direct-model has an effective context window of 8192 tokens",
        );
        expect(result.warning).toContain("at least 16384");
      } else {
        expect(result.warning).toBeUndefined();
      }
    },
  );

  it("leaves the context floor to setup callers, not the shared probe", async () => {
    const route = embeddedRoute("openclaw");
    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async () => {
      const reply = probeReply(route);
      const agentMeta = {
        sessionId: "probe",
        provider: route.provider,
        model: route.model,
        contextTokens: 8_192,
      };
      return { ...reply, meta: { ...reply.meta, agentMeta } };
    });
    await expect(runProbe(route)).resolves.toMatchObject({ ok: true, contextTokens: 8_192 });
  });

  it.each([
    ["ECONNREFUSED", "Nothing is listening at http://127.0.0.1:43210", "Start the server"],
    ["ENOTFOUND", "The server name in http://127.0.0.1:43210 could not be found", "DNS"],
    ["EHOSTUNREACH", "Cannot reach http://127.0.0.1:43210", "network"],
  ])(
    "explains a failed connection without calling it a timeout (%s)",
    async (code, message, nextStep) => {
      const route = embeddedRoute("openclaw");
      route.runConfig.models = {
        providers: {
          openai: {
            baseUrl: "http://127.0.0.1:43210/v1?key=synthetic-private-value",
            models: [],
          },
        },
      };
      let retryConnectionErrors: boolean | undefined;
      vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async (params) => {
        retryConnectionErrors = params.retryConnectionErrors;
        throw new FailoverError("Connection error.", { reason: "timeout", code });
      });
      const result = await runProbe(route);
      expect(result).toMatchObject({
        ok: false,
        status: "unavailable",
        error: expect.stringContaining(message),
      });
      expect(retryConnectionErrors).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(nextStep);
        expect(result.error).toContain("No default model was changed.");
        expect(result.error).not.toContain("synthetic-private-value");
      }
    },
  );

  it("waits for the isolated probe runtime to release its plugin work", async () => {
    const route = embeddedRoute();
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const removeTempDir = vi.spyOn(fs, "rm");
    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async () => {
      const trackOwner = captureAsyncWorkTracker();
      void trackOwner(async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      });
      return probeReply(route);
    });
    let settled = false;
    const turn = runProbe(route).finally(() => {
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
          const sql = observeMainThreadSql();
          try {
            sql.calibrate();
            const generation = await loadSetupInferencePluginGeneration({
              cache: generationCache,
              config,
              workspaceDir: state.workspaceDir,
              selection: { provider: "fixture", modelId: "model", runtime: "fixture-runtime" },
            });
            expect(generation.metadataSnapshot.byPluginId.has("fixture-runtime")).toBe(true);
            sql.expectIdle();
          } finally {
            sql.restore();
          }
          expect(resolvePluginMetadataSnapshot(input)).toBe(before);
        });
      },
    );
  });

  it("retains the probing registry artifact preference", async () => {
    const order: string[] = [];
    const pluginRegistry = createEmptyPluginRegistry();
    const route = embeddedRoute();
    const { binding } = await createSystemAgentVerifiedInferenceTestFixture(route.sourceConfig);
    const metadataSnapshot = createEmptyPluginMetadataSnapshot("/tmp/openclaw-workspace");
    const probingRegistry = createEmptyPluginRegistry();
    setPluginRuntimeLoadContext(
      probingRegistry,
      resolvePluginRuntimeLoadContext({
        config: route.runConfig,
        metadataSnapshot,
        preferBuiltPluginArtifacts: true,
      }),
    );
    const previousMetadata = getCurrentPluginMetadataSnapshot();
    vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync").mockImplementation(async () => {
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
        revalidateOwner(binding, createSystemAgentVerifiedInferenceBinding, route, {
          agentHarnessId: "codex",
          runtimeOwnerKind: "plugin-harness",
        }),
      ).resolves.toBe(binding);
    });

    expect(order).toEqual(["metadata", "load", "validate"]);
    expect(getCurrentPluginMetadataSnapshot()).toBe(previousMetadata);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        preferBuiltPluginArtifacts: true,
        selections: [
          { provider: "openai", modelId: "gpt-5.6-sol", runtime: "codex", agentId: "main" },
        ],
      }),
    );
  });

  it("does not load plugins for a direct custom provider using the built-in OpenClaw harness", async () => {
    const config = embeddedRoute("openclaw", "fixture", "direct-model").runConfig;
    config.models = createFixtureProviderModels("https://provider.example/v1");
    const { binding } = await createSystemAgentVerifiedInferenceTestFixture(config);
    expect(binding.ownerPluginIds).toEqual([]);
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();

    await expect(revalidateOwner(binding)).resolves.toBe(binding);

    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  });
});

describe("setup probe projection", () => {
  it.each(["end", "error"] as const)(
    "keeps a completed probe out of Gateway projection (%s)",
    async (phase) => {
      const route = embeddedRoute("openclaw");
      const events: AgentEventRuntimePayload[] = [];
      const persistLifecycle = vi.fn(async () => undefined);
      const gateway = createAgentEventTestHarness({
        persistGatewaySessionLifecycleEventForEvent: persistLifecycle,
        lifecycleErrorRetryGraceMs: 0,
      });
      gateway.nodeHasSessionSubscribers.mockReturnValue(false);
      gateway.clearAgentRunContext.mockImplementation(clearAgentRunContext);
      let runId: string | undefined;
      let unsubscribe = () => {};
      try {
        vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async (params) => {
          runId = params.runId;
          unsubscribe = onAgentEventForRun(params.runId, (event) => events.push(event));
          gateway.sessionMessageSubscribers.subscribe("probe-viewer", params.sessionKey!);
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
          return probeReply(route, "Internal setup response");
        });
        const result = await runProbe(route);
        expect(result).toMatchObject(
          phase === "end"
            ? { ok: true, text: "Internal setup response" }
            : { ok: false, error: expect.stringContaining("provider refused probe") },
        );
        expect(runId).toBeDefined();
        expect(getAgentRunContext(runId!)).toBeUndefined();

        // Gateway delivery can consume retained events after the producer has cleaned up.
        for (const event of events) {
          await gateway.handler(event);
        }
        [
          gateway.broadcast,
          gateway.broadcastToConnIds,
          gateway.nodeSendToSession,
          persistLifecycle,
        ].forEach((delivery) => expect(delivery).not.toHaveBeenCalled());
      } finally {
        unsubscribe();
        await gateway.handler.dispose();
        gateway.chatRunState.clear();
        if (runId) {
          clearAgentRunContext(runId);
        }
      }
    },
  );
});
