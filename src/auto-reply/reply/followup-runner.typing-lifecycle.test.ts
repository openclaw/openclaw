import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTypingCallbacks } from "../../channels/typing.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import type { FollowupRun } from "./queue.js";
import { createTypingController } from "./typing.js";

const state = vi.hoisted(() => ({
  account: vi.fn(),
  admit: vi.fn(),
  completeLifecycle: vi.fn(),
  deliver: vi.fn(),
  execute: vi.fn(),
  resolveDecision: vi.fn(),
  clearRunContext: vi.fn(),
}));

vi.mock("../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-run-registry.js")>()),
  clearAgentRunContext: (...args: unknown[]) => state.clearRunContext(...args),
}));

vi.mock("../../agents/embedded-agent-runner/delivery-evidence.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/embedded-agent-runner/delivery-evidence.js")
  >()),
  hasCompletedSourceReplyDeliveryEvidence: () => false,
}));

vi.mock("./agent-runner-result-accounting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-result-accounting.js")>()),
  accountFollowupTurn: (...args: unknown[]) => state.account(...args),
}));

vi.mock("./followup-turn-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-turn-admission.js")>()),
  admitFollowupTurn: (...args: unknown[]) => state.admit(...args),
}));

vi.mock("./followup-turn-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-turn-execution.js")>()),
  executeFollowupTurn: (...args: unknown[]) => state.execute(...args),
}));

vi.mock("./followup-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-delivery.js")>()),
  deliverFollowupDecision: (...args: unknown[]) => state.deliver(...args),
  resolveFollowupDeliveryDecision: (...args: unknown[]) => state.resolveDecision(...args),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  completeFollowupRunLifecycle: (...args: unknown[]) => state.completeLifecycle(...args),
}));

vi.mock("../../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: { ...actual.defaultRuntime, error: vi.fn() },
  };
});

const { createFollowupRunner } = await import("./followup-runner.js");

function createQueuedRun(): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  };
}

function createTurn(): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: createQueuedRun(),
    operation: {
      result: null,
      complete: vi.fn(),
      fail: vi.fn(),
    },
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: vi.fn(),
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  } as unknown as AdmittedFollowupTurn;
}

function createSettledExecution(): FollowupExecutionResult {
  return {
    commentaryPayloadsEnabled: false,
    execution: {
      runId: "run-1",
      outcome: {
        kind: "settled",
        status: "ok",
        result: { payloads: [], meta: { durationMs: 0 } },
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: 0,
        didLogHeartbeatStrip: false,
      },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: { drain: vi.fn(async () => {}) },
  } as FollowupExecutionResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.resolveDecision.mockReturnValue({ kind: "suppress", reason: "silent" });
  state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });
  state.account.mockResolvedValue(undefined);
});

describe("queued follow-up typing lifecycle", () => {
  it("publishes processing on the successor generation after the predecessor is sealed", async () => {
    const events: string[] = [];
    let generation = 0;
    const callbacks = createTypingCallbacks({
      start: async () => {
        events.push(`processing#${generation}`);
      },
      stop: async () => {
        events.push(`active#${generation}`);
      },
      onStartError: () => {},
      keepaliveIntervalMs: 0,
      maxDurationMs: 0,
    });
    const typing = createTypingController({
      onReplyStart: callbacks.onReplyStart,
      onCleanup: callbacks.onCleanup,
      onOpenSuccessor: () => {
        generation += 1;
        return callbacks.beginNextLifecycle?.();
      },
      typingIntervalSeconds: 0,
    });
    await typing.startTypingLoop();
    typing.markRunComplete();
    typing.markDispatchIdle();
    callbacks.onIdle?.();
    await Promise.resolve();

    const turn = createTurn();
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockImplementation(async (params: { defaults: { typing: typeof typing } }) => {
      await params.defaults.typing.startTypingLoop();
      events.push("followup-started");
      return createSettledExecution();
    });

    await createFollowupRunner({
      typing,
      typingMode: "instant",
      defaultModel: "claude",
    })(turn.queued);
    await Promise.resolve();

    expect(events).toEqual([
      "processing#0",
      "active#0",
      "processing#1",
      "followup-started",
      "active#1",
    ]);
    const finished = [...events];
    callbacks.onIdle?.();
    callbacks.onCleanup?.();
    typing.markRunComplete();
    typing.markDispatchIdle();
    await typing.startTypingLoop();
    await Promise.resolve();
    expect(events).toEqual(finished);
  });
});
