import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
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
  ensureSelectedAgentHarnessPlugin: vi.fn(),
  isCliProvider: vi.fn(() => false),
  LiveSessionModelSwitchError: class LiveSessionModelSwitchError extends Error {},
  logWarn: runtimeMocks.logWarn,
  normalizeVerboseLevel: vi.fn((value) => value),
  registerAgentRunContext: vi.fn(),
  resolveBootstrapWarningSignaturesSeen: vi.fn(() => []),
  resolveCronAgentLane: vi.fn((lane?: string) => lane ?? "cron"),
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

function hasTerminalControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x7f
    );
  });
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
      suppressExecNotifyOnExit: false,
      resolvedDelivery: { channel: "discord" },
      sourceDelivery: createSourceDeliveryPlan({
        owner: "direct_fallback",
        reason: "cron_announce",
        target: { channel: "discord" },
        messageToolEnabled: true,
        messageToolForced: false,
        directFallback: true,
      }),
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [], version: 1 },
      agentPayload: { kind: "agentTurn", message: "review tasks" },
      useSubagentFallbacks: false,
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

  it("sanitizes terminal control sequences before persisting cron progress", async () => {
    runtimeMocks.runWithModelFallback.mockImplementation(
      async (params: {
        onFallbackStep?: (step: Record<string, unknown>) => void | Promise<void>;
      }) => {
        await params.onFallbackStep?.({
          fallbackStepType: "fallback_step",
          fallbackStepFromModel: "openai/\u001b[31mgpt\u001b[0m",
          fallbackStepToModel: "anthropic/\u009d0;owned-c1-title\u009cclaude",
          fallbackStepFromFailureReason: "rate\nlimit",
          fallbackStepFromFailureDetail:
            "quota \u009d8;;https://example.invalid\u009chidden\u009c request",
          fallbackStepChainPosition: 1,
          fallbackStepFinalOutcome: "succeeded",
          fallbackStepQueueActive: 1,
          fallbackStepQueueQueued: 0,
          fallbackStepQueueDraining: false,
        });
        return {
          result: { payloads: [{ text: "done" }], meta: {} },
          provider: "anthropic",
          model: "claude",
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
      suppressExecNotifyOnExit: false,
      resolvedDelivery: { channel: "discord" },
      sourceDelivery: createSourceDeliveryPlan({
        owner: "direct_fallback",
        reason: "cron_announce",
        target: { channel: "discord" },
        messageToolEnabled: true,
        messageToolForced: false,
        directFallback: true,
      }),
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [], version: 1 },
      agentPayload: { kind: "agentTurn", message: "review tasks" },
      useSubagentFallbacks: false,
      liveSelection: {
        provider: "openai\u001b]8;;https://example.invalid\u0007\u009d0;owned-primary\u009c",
        model: "gpt\nmodel\tname",
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

    const progressSummaries = taskRuntimeMocks.recordTaskRunProgressByRunId.mock.calls.map(
      ([call]) => call.progressSummary,
    );
    const joinedProgress = progressSummaries.join("\n");
    expect(hasTerminalControlCharacter(joinedProgress)).toBe(false);
    expect(joinedProgress).not.toContain("[31m");
    expect(joinedProgress).not.toContain("[0m");
    expect(joinedProgress).not.toContain("]0;");
    expect(joinedProgress).not.toContain("]8;;");
    expect(joinedProgress).not.toContain("owned-c1-title");
    expect(joinedProgress).not.toContain("owned-primary");
    expect(progressSummaries[0]).toBe(
      "model primary=openai/gpt model name; queue active=0 queued=0 draining=no",
    );
    expect(progressSummaries[1]).toBe(
      "model fallback: openai/gpt -> anthropic/claude reason=rate limit outcome=succeeded detail=quota hidden request; queue active=1 queued=0 draining=no",
    );
  });
});
