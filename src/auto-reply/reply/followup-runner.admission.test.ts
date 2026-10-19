import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import { enqueueFollowupRun, type FollowupRun } from "./queue.js";
import type { FollowupRunnerParams } from "./reply-agent-turn-preparation.js";
import type { TypingController } from "./typing.js";

const state = vi.hoisted(() => ({
  account: vi.fn<typeof import("./agent-runner-result-accounting.js").accountFollowupTurn>(),
  deliver: vi.fn<typeof import("./followup-delivery.js").deliverFollowupDecision>(),
  execute: vi.fn<typeof import("./followup-turn-execution.js").executeFollowupTurn>(),
  preflight: vi.fn<typeof import("./agent-runner-memory.js").runSessionCompactionIfNeeded>(),
  resolveDecision: vi.fn<typeof import("./followup-delivery.js").resolveFollowupDeliveryDecision>(),
}));

vi.mock("./agent-runner-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-memory.js")>()),
  runMemoryFlushIfNeeded: vi.fn(),
  runSessionCompactionIfNeeded: (
    ...args: Parameters<typeof import("./agent-runner-memory.js").runSessionCompactionIfNeeded>
  ) => state.preflight(...args),
}));

vi.mock("./agent-runner-result-accounting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-result-accounting.js")>()),
  accountFollowupTurn: (
    ...args: Parameters<typeof import("./agent-runner-result-accounting.js").accountFollowupTurn>
  ) => state.account(...args),
}));

vi.mock("./followup-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-delivery.js")>()),
  deliverFollowupDecision: (
    ...args: Parameters<typeof import("./followup-delivery.js").deliverFollowupDecision>
  ) => state.deliver(...args),
  resolveFollowupDeliveryDecision: (
    ...args: Parameters<typeof import("./followup-delivery.js").resolveFollowupDeliveryDecision>
  ) => state.resolveDecision(...args),
}));

vi.mock("./followup-turn-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-turn-execution.js")>()),
  executeFollowupTurn: (
    ...args: Parameters<typeof import("./followup-turn-execution.js").executeFollowupTurn>
  ) => state.execute(...args),
}));

// mock-isolation: Exercise queue admission and source acceptance without starting a model runtime.
vi.mock("./agent-runner-execution.js", () => ({
  executeAgentTurn: async () => createSettledExecution().execution,
}));

const { createFollowupRunner } = await import("./followup-runner.js");

function createQueuedRun(sessionKey: string): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: `${sessionKey}-session`,
      sessionKey,
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

function createTypingController(): TypingController {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  };
}

function createSettledExecution(): FollowupExecutionResult {
  return {
    commentaryPayloadsEnabled: false,
    execution: {
      runId: "followup-run",
      outcome: {
        kind: "settled",
        status: "ok",
        result: { payloads: [], meta: { durationMs: 0 } },
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: 0,
      },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: { drain: vi.fn(async () => {}) },
  };
}

const activeKeys = new Set<string>();

afterEach(async () => {
  for (const key of activeKeys) {
    const operation = getSessionControllerOperation(key);
    operation?.complete();
    await operation?.ownerSettlement;
  }
  activeKeys.clear();
});

beforeEach(() => {
  vi.clearAllMocks();
  state.account.mockResolvedValue(undefined);
  state.execute.mockResolvedValue(createSettledExecution());
  state.preflight.mockImplementation(async (params) => params.sessionEntry);
  state.resolveDecision.mockResolvedValue({ kind: "suppress", reason: "silent" });
  state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });
});

// Exercises policy refresh through the same queue and admission owners as a drained follow-up.
async function runPolicyRefreshScenario(params: {
  sessionKey: string;
  refreshedPolicy: "allow" | "deny";
}): Promise<void> {
  activeKeys.add(params.sessionKey);
  const sessionEntry: InternalSessionEntry = {
    sessionId: `${params.sessionKey}-session`,
    updatedAt: Date.now(),
    sendPolicy: "allow",
  };
  const queued = createQueuedRun(params.sessionKey);
  queued.run.sessionId = sessionEntry.sessionId;
  queued.run.config = { agents: { defaults: { compaction: { notifyUser: true } } } };
  state.preflight.mockImplementation(async (input) => {
    await input.onCompactionNotice?.("end", "Context compacted");
    sessionEntry.sendPolicy = params.refreshedPolicy;
    return sessionEntry;
  });
  const defaults: FollowupRunnerParams = {
    typing: createTypingController(),
    typingMode: "never",
    defaultModel: "anthropic/claude",
    sessionEntry,
    sessionStore: { [params.sessionKey]: sessionEntry },
  };
  const completed = createDeferred();
  const runner = createFollowupRunner(defaults);
  expect(
    enqueueFollowupRun(
      params.sessionKey,
      queued,
      { mode: "followup", debounceMs: 0 },
      "none",
      async (run) => {
        await runner(run);
        completed.resolve();
      },
    ),
  ).toBe(true);

  await completed.promise;
  expect(getSessionControllerOperation(params.sessionKey)).toBeUndefined();
}

describe("createFollowupRunner admission ownership", () => {
  it("releases the admitted operation when source adoption fails", async () => {
    const { executeFollowupTurn } = await vi.importActual<
      typeof import("./followup-turn-execution.js")
    >("./followup-turn-execution.js");
    state.execute.mockImplementation(executeFollowupTurn);
    const sessionKey = "agent:main:followup-adoption-failure";
    activeKeys.add(sessionKey);
    const queued = createQueuedRun(sessionKey);
    const failure = new Error("source adoption failed");
    const onAdopted = vi.fn().mockRejectedValue(failure);
    queued.turnAdoptionLifecycle = { onAdopted };
    const typing = createTypingController();
    const runner = createFollowupRunner({
      typing,
      typingMode: "never",
      defaultModel: "anthropic/claude",
    });
    const completed = createDeferred();
    const runFollowup = async (run: FollowupRun) => {
      await runner(run);
      completed.resolve();
    };
    expect(
      enqueueFollowupRun(
        sessionKey,
        queued,
        { mode: "followup", debounceMs: 0 },
        "none",
        runFollowup,
      ),
    ).toBe(true);

    await completed.promise;
    expect(state.execute).toHaveBeenCalledOnce();
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
  });

  it("suppresses a deferred compaction notice after preflight refreshes policy to deny", async () => {
    await runPolicyRefreshScenario({
      sessionKey: "agent:main:followup-policy-control",
      refreshedPolicy: "allow",
    });
    expect(state.deliver.mock.calls.filter(([params]) => params.kind === "block")).toHaveLength(1);

    state.deliver.mockClear();
    state.execute.mockClear();
    await runPolicyRefreshScenario({
      sessionKey: "agent:main:followup-policy-refresh",
      refreshedPolicy: "deny",
    });
    expect(state.deliver.mock.calls.filter(([params]) => params.kind === "block")).toHaveLength(0);
    expect(state.execute).toHaveBeenCalledOnce();
  });
});
