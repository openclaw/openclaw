import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../agents/failover-error.js";
import * as simpleCompletionExecution from "../agents/simple-completion-execution.js";
import * as simpleCompletionRuntime from "../agents/simple-completion-runtime.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  readSessionTranscriptWatermark,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { prewarmSessionHistoryWorker } from "../config/sessions/session-transcript-worker-runtime.js";
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

  beforeEach(async () => {
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
      snapshot: {
        config,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        metadataSnapshot: createEmptyPluginMetadataSnapshot(state.workspaceDir),
        pluginRegistry: createEmptyPluginRegistry(),
      },
      [Symbol.asyncDispose]: async () => {},
    });
    runtimeMocks.runEmbeddedAttempt.mockReset();
    // Keep routing and the built-in zero-tool execution real; isolate only auth and transport.
    vi.spyOn(simpleCompletionRuntime, "prepareSimpleCompletionModel").mockImplementation(
      async (params) => ({
        model: {
          provider: params.provider,
          id: params.modelId,
          name: "Utility fixture",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_768,
          maxTokens: 16_384,
        },
        auth: { apiKey: "synthetic-utility-key", mode: "api-key", source: "test" },
      }),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSessionObserverEventSequence();
    await state.cleanup();
  });

  it.each([false, true])(
    "publishes the observer digest without inheriting session harness state: fallback=%s",
    async (fallback) => {
      if (fallback) {
        config.agents!.defaults!.utilityModel = {
          primary: "openai/gpt-5.4-mini",
          fallbacks: ["openai/utility-backup"],
        };
        config.agents!.entries!.main!.model = {
          primary: "openai/gpt-5.4",
          fallbacks: ["openai/main-backup"],
        };
      }
      const transport = vi
        .spyOn(simpleCompletionExecution, "completeWithPreparedSimpleCompletionModel")
        .mockResolvedValue(
          makeAssistantMessageFixture({
            stopReason: "stop",
            content: [
              { type: "text", text: '{"headline":"Checking the fix","health":"on-track"}' },
            ],
          }),
        );
      if (fallback) {
        transport.mockRejectedValueOnce(
          new FailoverError("Fixture server unavailable", { reason: "server_error" }),
        );
      }
      vi.useFakeTimers();
      const observer = createHarness({
        config,
        utilityModelRef: "openai/gpt-5.4-mini",
        prepareModel: vi.fn(defaultPrepareModel),
        completeModel: vi.fn(defaultCompleteModel),
        readSession: vi.fn(() => ({
          sessionId: "session-id",
          updatedAt: 0,
          agentHarnessId: "openclaw",
        })),
      });
      try {
        startAndAddToolNotes(observer.observer);
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
        expect(transport).toHaveBeenCalledWith(
          expect.objectContaining({
            context: expect.objectContaining({ tools: [] }),
            options: expect.objectContaining({
              maxTokens: 300,
              temperature: 0.2,
              reasoning: "off",
            }),
          }),
        );
        expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
        expect(transport.mock.calls.map(([request]) => request.model.id)).toEqual(
          fallback ? ["gpt-5.4-mini", "utility-backup"] : ["gpt-5.4-mini"],
        );
      } finally {
        observer.observer.dispose();
      }
    },
  );

  it.each(["direct", "backup", "exhausted"] as const)(
    "preserves Activity recap behavior through the utility chain: %s",
    async (outcome) => {
      if (outcome !== "direct") {
        config.agents!.defaults!.utilityModel = {
          primary: "openai/gpt-5.4-mini",
          fallbacks: ["openai/utility-backup"],
        };
        config.agents!.entries!.main!.model = {
          primary: "openai/gpt-5.4",
          fallbacks: ["openai/main-backup"],
        };
      }
      const text = "Finished checking the requested fix.";
      const transport = vi
        .spyOn(simpleCompletionExecution, "completeWithPreparedSimpleCompletionModel")
        .mockResolvedValue(
          makeAssistantMessageFixture({ stopReason: "stop", content: [{ type: "text", text }] }),
        );
      if (outcome !== "direct") {
        transport.mockRejectedValueOnce(
          new FailoverError("Fixture credentials rejected", { reason: "auth" }),
        );
      }
      if (outcome === "exhausted") {
        transport.mockRejectedValue(
          new FailoverError("Fixture credentials rejected", { reason: "auth" }),
        );
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
          {
            eventId: "message-1",
            parentId: null,
            message: { role: "user", content: "Check the fix." },
          },
        ],
        touchSessionEntry: false,
      });
      // Warm the fixture's database before timing utility completion.
      await prewarmSessionHistoryWorker({ agentId: scope.agentId, env: state.env });
      const complete = vi.fn(defaultCompleteModel);
      const recaps = createSessionActivitySummaries({
        scheduler: createTestGatewayScheduler(),
        getConfig: () => config,
        onChanged: vi.fn(),
        completeModel: complete,
      });
      try {
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
        expect(transport).toHaveBeenCalledWith(
          expect.objectContaining({
            context: expect.objectContaining({ tools: [] }),
            options: expect.objectContaining({
              maxTokens: 240,
              temperature: 0.2,
              reasoning: "off",
            }),
          }),
        );
        expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
        expect(transport.mock.calls.map(([request]) => request.model.id)).toEqual(
          outcome === "direct" ? ["gpt-5.4-mini"] : ["gpt-5.4-mini", "utility-backup"],
        );
      } finally {
        await recaps.dispose();
      }
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
    const metadataSnapshot = createEmptyPluginMetadataSnapshot(state.workspaceDir);
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
    runtimeMocks.acquire.mockResolvedValue({
      snapshot: {
        config,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        metadataSnapshot,
        pluginRegistry: registry,
      },
      [Symbol.asyncDispose]: release,
    });
    const builtInTransport = vi
      .spyOn(simpleCompletionExecution, "completeWithPreparedSimpleCompletionModel")
      .mockRejectedValue(new Error("Unexpected built-in utility completion"));
    const prepared = await defaultPrepareModel({
      cfg: config,
      agentId: "main",
      useUtilityModel: true,
    });

    await expect(
      withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
        () =>
          defaultCompleteModel({
            ...prepared,
            systemPrompt: "Return a short reply.",
            prompt: "Check the fix.",
            timeoutMs: 1000,
          }),
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
      const prepared = await defaultPrepareModel({
        cfg: config,
        agentId: "main",
        useUtilityModel: true,
      });
      await expect(
        defaultCompleteModel({
          ...prepared,
          ...(source === "request override" ? { agentHarnessRuntimeOverride: "codex" } : {}),
          systemPrompt: "Return a short reply.",
          prompt: "Check the fix.",
          timeoutMs: 1000,
        }),
      ).rejects.toThrow('Agent harness runtime "codex" is unavailable');
      expect(simpleCompletionRuntime.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
    },
  );
});
