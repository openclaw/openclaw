import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as simpleCompletionExecution from "../agents/simple-completion-execution.js";
import * as simpleCompletionRuntime from "../agents/simple-completion-runtime.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { createEmptyPluginMetadataSnapshot } from "../agents/test-helpers/embedded-agent-runner-e2e-mocks.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
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
    vi.spyOn(simpleCompletionRuntime, "prepareSimpleCompletionModel").mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "Utility fixture",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
      auth: { apiKey: "synthetic-utility-key", mode: "api-key", source: "test" },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSessionObserverEventSequence();
    await state.cleanup();
  });

  it("publishes the observer digest through OpenClaw without inheriting session harness state", async () => {
    const transport = vi
      .spyOn(simpleCompletionExecution, "completeWithPreparedSimpleCompletionModel")
      .mockResolvedValue(
        makeAssistantMessageFixture({
          stopReason: "stop",
          content: [{ type: "text", text: '{"headline":"Checking the fix","health":"on-track"}' }],
        }),
      );
    vi.useFakeTimers();
    const observer = createHarness({
      config,
      utilityModelRef: config.agents?.defaults?.utilityModel,
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
        expect.objectContaining({ context: expect.objectContaining({ tools: [] }) }),
      );
      expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
    } finally {
      observer.observer.dispose();
    }
  });

  it("persists an Activity recap through the same OpenClaw utility completion", async () => {
    const text = "Finished checking the requested fix.";
    const transport = vi
      .spyOn(simpleCompletionExecution, "completeWithPreparedSimpleCompletionModel")
      .mockResolvedValue(
        makeAssistantMessageFixture({ stopReason: "stop", content: [{ type: "text", text }] }),
      );
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
    const complete = vi.fn(defaultCompleteModel);
    const recaps = createSessionActivitySummaries({
      getConfig: () => config,
      onChanged: vi.fn(),
      completeModel: complete,
    });
    try {
      recaps.ensure(target);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
      await expect(complete.mock.results[0]?.value).resolves.toMatchObject({
        owner: { kind: "harness", id: "openclaw" },
      });
      await vi.waitFor(() => {
        const entry = loadSessionEntryReadOnly(scope);
        expect(projectSessionActivitySummary({ ...target, cfg: config, entry })).toMatchObject({
          state: "current",
          text,
        });
      });
      expect(transport).toHaveBeenCalledWith(
        expect.objectContaining({ context: expect.objectContaining({ tools: [] }) }),
      );
      expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
    } finally {
      await recaps.dispose();
    }
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
