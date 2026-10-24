import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../agents/failover-error.js";
import * as execution from "../agents/simple-completion-execution.js";
import * as runtime from "../agents/simple-completion-runtime.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import * as utilityCompletion from "../agents/utility-completion.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  readSessionTranscriptWatermark,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { prewarmSessionHistoryWorker } from "../config/sessions/session-transcript-worker-runtime.js";
import { transcriptMessage } from "../config/sessions/transcript-message.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createSessionActivitySummaries } from "./session-activity-summaries.js";
import { projectSessionActivitySummary } from "./session-activity-summary-state.js";
import { defaultCompleteModel, defaultPrepareModel } from "./session-observer-model.js";
import * as observerModel from "./session-observer-model.js";
import {
  createHarness,
  flushObserver,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

const runtimeMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  runEmbeddedAttempt: vi.fn(),
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: runtimeMocks.acquire,
}));
vi.mock("../agents/embedded-agent-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: runtimeMocks.runEmbeddedAttempt,
}));

describe("utility completion with an unavailable implicit harness", () => {
  let state: OpenClawTestState;
  let config: OpenClawConfig;
  let dispose: (() => void | Promise<void>) | undefined;
  const completionPrompt = {
    systemPrompt: "Return a short reply.",
    prompt: "Check the fix.",
    timeoutMs: 1000,
  };
  const prepare = () =>
    defaultPrepareModel({ cfg: config, agentId: "main", useUtilityModel: true });
  const runtimeSnapshot = (pluginRegistry = createEmptyPluginRegistry()) => ({
    config,
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    metadataSnapshot: createEmptyPluginMetadataSnapshot(state.workspaceDir),
    pluginRegistry,
  });
  const useFallbacks = () => {
    config.agents!.defaults!.utilityModel = {
      primary: "openai/gpt-5.4-mini",
      fallbacks: ["openai/utility-backup"],
    };
    config.agents!.entries!.main!.model = {
      primary: "openai/gpt-5.4",
      fallbacks: ["openai/main-backup"],
    };
  };
  const transportReply = (text: string) =>
    vi
      .spyOn(execution, "completeWithPreparedSimpleCompletionModel")
      .mockResolvedValue(
        makeAssistantMessageFixture({ stopReason: "stop", content: [{ type: "text", text }] }),
      );
  const expectBuiltInCompletion = (
    transport: ReturnType<typeof transportReply>,
    maxTokens: number,
    fallback: boolean,
  ) => {
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      context: { tools: [] },
      options: { maxTokens, temperature: 0.2, reasoning: "off" },
    });
    expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
    expect(transport.mock.calls.map(([request]) => request.model.id)).toEqual(
      fallback ? ["gpt-5.4-mini", "utility-backup"] : ["gpt-5.4-mini"],
    );
  };

  beforeEach(async () => {
    vi.spyOn(utilityCompletion, "hasAvailableUtilityCompletionAuth").mockResolvedValue(true);
    dispose = undefined;
    state = await createOpenClawTestState({ scenario: "minimal" });
    config = {
      agents: {
        defaults: { utilityModel: "openai/gpt-5.4-mini", workspace: state.workspaceDir },
        entries: {
          main: {
            model: "openai/gpt-5.4",
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      plugins: { entries: { codex: { enabled: false } } },
    };
    setRuntimeConfigSnapshot(config);
    runtimeMocks.acquire.mockReset().mockResolvedValue({
      snapshot: runtimeSnapshot(),
      [Symbol.asyncDispose]: async () => {},
    });
    runtimeMocks.runEmbeddedAttempt.mockReset();
    // Keep routing and the built-in zero-tool execution real; isolate only auth and transport.
    vi.spyOn(runtime, "prepareSimpleCompletionModel").mockImplementation(
      async ({ provider, modelId: id }) => ({
        model: makeProviderModelFixture({
          provider,
          id,
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
        }),
        auth: { apiKey: "synthetic-utility-key", mode: "api-key", source: "test" },
      }),
    );
  });

  afterEach(async () => {
    try {
      await dispose?.();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      resetSessionObserverEventSequence();
      await state.cleanup();
    }
  });

  it.each([false, true])(
    "publishes the observer digest without inheriting session harness state: fallback=%s",
    async (fallback) => {
      const transport = transportReply('{"headline":"Checking the fix","health":"on-track"}');
      if (fallback) {
        useFallbacks();
        transport.mockRejectedValueOnce(
          new FailoverError("Fixture server unavailable", { reason: "server_error" }),
        );
      }
      vi.useFakeTimers();
      const observer = createHarness({
        config,
        prepareModel: vi.fn(defaultPrepareModel),
        completeModel: vi.fn(defaultCompleteModel),
        readSession: vi.fn(() => ({
          sessionId: "session-id",
          updatedAt: 0,
          agentHarnessId: "openclaw",
        })),
      });
      dispose = () => observer.observer.disposeAsync();
      await startAndAddToolNotes(observer.observer);
      await vi.advanceTimersByTimeAsync(12_000);
      await vi.dynamicImportSettled();
      await flushObserver();

      expect(observer.completeModel).toHaveBeenCalledOnce();
      await expect(observer.completeModel.mock.results[0]?.value).resolves.toMatchObject({
        owner: { kind: "harness", id: "openclaw" },
      });
      expect(observer.broadcastToConnIds).toHaveBeenCalledWith(
        "session.observer",
        expect.objectContaining({ headline: "Checking the fix", health: "on-track" }),
        expect.any(Set),
        expect.anything(),
      );
      expectBuiltInCompletion(transport, 300, fallback);
    },
  );

  it.each(["direct", "backup", "exhausted"] as const)(
    "preserves Activity recap behavior through the utility chain: %s",
    async (outcome) => {
      const text = "Finished checking the requested fix.";
      const transport = transportReply(text);
      const rejected = new FailoverError("Fixture credentials rejected", { reason: "auth" });
      if (outcome !== "direct") {
        useFallbacks();
        transport.mockRejectedValueOnce(rejected);
      }
      if (outcome === "exhausted") {
        transport.mockRejectedValue(rejected);
      }
      const target = { key: "agent:main:recap", agentId: "main" };
      const scope = { sessionKey: target.key, agentId: target.agentId, sessionId: "recap-session" };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        lifecycleRevision: "lifecycle-1",
        updatedAt: 1,
        agentHarnessId: "openclaw",
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("message-1", null, { role: "user", content: "Check the fix." }),
        ],
        touchSessionEntry: false,
      });
      // Warm the fixture's database before timing utility completion.
      await prewarmSessionHistoryWorker({ agentId: scope.agentId, env: state.env });
      const complete = vi.spyOn(observerModel, "defaultCompleteModel");
      const recaps = createSessionActivitySummaries({
        scheduler: createTestGatewayScheduler(),
        getConfig: () => config,
        onChanged: vi.fn(),
      });
      dispose = () => recaps.dispose();
      await recaps.ensure(target, await readSessionEntryReadOnlyInWorker(scope));
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
      if (outcome === "exhausted") {
        await expect(complete.mock.results[0]?.value).rejects.toThrow();
      } else {
        await expect(complete.mock.results[0]?.value).resolves.toMatchObject({
          owner: { kind: "harness", id: "openclaw" },
        });
      }
      await vi.waitFor(() => {
        const entry = loadSessionEntryReadOnly(scope);
        expect(
          projectSessionActivitySummary({
            ...target,
            cfg: config,
            entry,
            watermark: readSessionTranscriptWatermark(scope),
          }),
        ).toMatchObject(
          outcome === "exhausted" ? { state: "unavailable" } : { state: "current", text },
        );
        if (outcome === "exhausted") {
          expect(entry?.activitySummary).toBeUndefined();
        }
      });
      expectBuiltInCompletion(transport, 240, outcome !== "direct");
    },
  );

  it("admits the utility harness from its run-owned registry before validating registration", async () => {
    config.agents!.defaults!.utilityModel = {
      primary: "utility-fixture/small",
      fallbacks: ["utility-fixture/backup"],
    };
    config.agents!.entries!.main!.models!["utility-fixture/small"] = {
      agentRuntime: { id: "admitted-utility" },
    };
    const registry = createEmptyPluginRegistry();
    const dispatch = vi.fn(async () => ({
      assistant: makeAssistantMessageFixture({
        stopReason: "stop",
        provider: "utility-fixture",
        model: "small",
        content: [{ type: "text", text: "The admitted utility harness answered." }],
      }),
    }));
    registry.agentHarnesses.push({
      pluginId: "utility-fixture",
      source: "fixture",
      harness: {
        id: "admitted-utility",
        label: "Admitted utility fixture",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("The utility fixture only supports isolated completion");
        },
        runIsolatedCompletionV2: dispatch,
      },
    });
    const release = vi.fn(async () => {});
    const snapshot = runtimeSnapshot(registry);
    runtimeMocks.acquire.mockResolvedValue({
      snapshot,
      [Symbol.asyncDispose]: release,
    });
    const builtInTransport = vi
      .spyOn(execution, "completeWithPreparedSimpleCompletionModel")
      .mockRejectedValue(new Error("Unexpected built-in utility completion"));
    const prepared = await prepare();

    await expect(
      withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: snapshot.metadataSnapshot,
          pluginRegistry: createEmptyPluginRegistry(),
        },
        () => defaultCompleteModel({ ...prepared, ...completionPrompt }),
      ),
    ).resolves.toMatchObject({
      text: "The admitted utility harness answered.",
      owner: { kind: "harness", id: "admitted-utility" },
    });
    expect(runtimeMocks.acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(builtInTransport).not.toHaveBeenCalled();
    expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it.each(["model policy", "request override"])(
    "rejects an unavailable explicit Codex %s before preparing credentials",
    async (source) => {
      if (source === "model policy") {
        config.agents!.entries!.main!.models!["openai/gpt-5.4-mini"] = {
          agentRuntime: { id: "codex" },
        };
      }
      const prepared = await prepare();
      await expect(
        defaultCompleteModel({
          ...prepared,
          ...completionPrompt,
          ...(source === "request override" ? { agentHarnessRuntimeOverride: "codex" } : {}),
        }),
      ).rejects.toThrow('Agent harness runtime "codex" is unavailable');
      expect(runtime.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
    },
  );
});
