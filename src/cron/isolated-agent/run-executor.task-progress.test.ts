import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";

const runtimeMocks = vi.hoisted(() => ({
  runWithModelFallback: vi.fn(),
  resolveEffectiveModelFallbacks: vi.fn(() => undefined),
  logWarn: vi.fn(),
}));

const taskRuntimeMocks = vi.hoisted(() => ({
  recordTaskRunProgressByRunId: vi.fn(),
}));

vi.mock("./run-execution.runtime.js", () => ({
  getCliSessionId: vi.fn(),
  isCliProvider: vi.fn(() => false),
  LiveSessionModelSwitchError: class LiveSessionModelSwitchError extends Error {},
  logWarn: runtimeMocks.logWarn,
  normalizeVerboseLevel: vi.fn((value) => value),
  registerAgentRunContext: vi.fn(),
  resolveBootstrapWarningSignaturesSeen: vi.fn(() => []),
  resolveEffectiveModelFallbacks: runtimeMocks.resolveEffectiveModelFallbacks,
  resolveSessionTranscriptPath: vi.fn(() => "/tmp/openclaw-cron-test-session.jsonl"),
  runCliAgent: vi.fn(),
  runWithModelFallback: runtimeMocks.runWithModelFallback,
}));

vi.mock("../../tasks/detached-task-runtime.js", () => ({
  recordTaskRunProgressByRunId: taskRuntimeMocks.recordTaskRunProgressByRunId,
}));

const { createCronPromptExecutor } = await import("./run-executor.js");

function makeJob(): CronJob {
  return {
    id: "weekly-task-review",
    name: "weekly-task-review",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "review tasks" },
    state: {},
    createdAtMs: 1,
    updatedAtMs: 1,
  } as CronJob;
}

describe("cron isolated run model progress", () => {
  beforeEach(() => {
    runtimeMocks.runWithModelFallback.mockReset();
    runtimeMocks.resolveEffectiveModelFallbacks.mockClear();
    runtimeMocks.logWarn.mockClear();
    taskRuntimeMocks.recordTaskRunProgressByRunId.mockClear();
  });

  it("records primary, fallback, and queue causality to the cron task ledger", async () => {
    runtimeMocks.runWithModelFallback.mockImplementation(
      async (params: {
        onFallbackStep?: (step: Record<string, unknown>) => void | Promise<void>;
      }) => {
        await params.onFallbackStep?.({
          fallbackStepType: "fallback_step",
          fallbackStepFromModel: "openai/gpt-5.5-preview",
          fallbackStepToModel: "github-copilot/gpt-5-mini",
          fallbackStepFromFailureReason: "model_not_found",
          fallbackStepFromFailureDetail: "unsupported model",
          fallbackStepChainPosition: 1,
          fallbackStepFinalOutcome: "next_fallback",
          fallbackStepQueueActive: 1,
          fallbackStepQueueQueued: 2,
          fallbackStepQueueDraining: false,
        });
        return {
          result: { payloads: [{ text: "done" }], meta: {} },
          provider: "github-copilot",
          model: "gpt-5-mini",
        };
      },
    );

    const executor = createCronPromptExecutor({
      cfg: {},
      cfgWithAgentDefaults: {},
      job: makeJob(),
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      agentSessionKey: "agent:main",
      runSessionKey: "cron:weekly-task-review",
      workspaceDir: "/tmp/openclaw-workspace",
      resolvedVerboseLevel: "off",
      thinkLevel: undefined,
      timeoutMs: 60_000,
      messageChannel: undefined,
      suppressExecNotifyOnExit: false,
      resolvedDelivery: {},
      toolPolicy: {
        requireExplicitMessageTarget: false,
        disableMessageTool: false,
        forceMessageTool: false,
      },
      skillsSnapshot: { prompt: "", skills: [] },
      agentPayload: { kind: "agentTurn", message: "review tasks" },
      liveSelection: {
        provider: "openai",
        model: "gpt-5.5-preview",
      },
      cronSession: {
        storePath: "/tmp/openclaw-cron-sessions.json",
        store: {},
        systemSent: false,
        isNewSession: true,
        previousSessionId: undefined,
        sessionEntry: {
          sessionId: "cron-session",
          sessionFile: "/tmp/openclaw-cron-test-session.jsonl",
          updatedAt: 1,
        },
      },
      abortReason: () => "aborted",
      taskRunId: "cron-run-1",
    });

    await executor.runPrompt("review tasks");

    expect(taskRuntimeMocks.recordTaskRunProgressByRunId).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runId: "cron-run-1",
        runtime: "cron",
        progressSummary:
          "model primary=openai/gpt-5.5-preview; queue active=0 queued=0 draining=no",
      }),
    );
    expect(taskRuntimeMocks.recordTaskRunProgressByRunId).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runId: "cron-run-1",
        runtime: "cron",
        progressSummary:
          "model fallback: openai/gpt-5.5-preview -> github-copilot/gpt-5-mini reason=model_not_found outcome=next_fallback detail=unsupported model; queue active=1 queued=2 draining=no",
      }),
    );
  });
});
