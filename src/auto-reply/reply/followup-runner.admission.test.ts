import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import { enqueueFollowupRun, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type { FollowupRunnerParams } from "./reply-agent-turn-preparation.js";
import { createMockTypingController as createTypingController } from "./test-helpers.js";

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
  runSessionCompactionIfNeeded: state.preflight,
}));

vi.mock("./agent-runner-result-accounting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-result-accounting.js")>()),
  accountFollowupTurn: state.account,
}));

vi.mock("./followup-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-delivery.js")>()),
  deliverFollowupDecision: state.deliver,
  resolveFollowupDeliveryDecision: state.resolveDecision,
}));

vi.mock("./followup-turn-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-turn-execution.js")>()),
  executeFollowupTurn: state.execute,
}));

// mock-isolation: Exercise queue admission and source acceptance without starting a model runtime.
vi.mock("./agent-runner-execution.js", () => ({
  executeAgentTurn: async () => createSettledExecution().execution,
}));

const { createFollowupRunner } = await import("./followup-runner.js");

function createQueuedRun(sessionKey: string): FollowupRun {
  const queued = createQueueTestRun({ prompt: "queued prompt" });
  Object.assign(queued.run, {
    agentId: "main",
    sessionId: `${sessionKey}-session`,
    sessionKey,
    provider: "anthropic",
    model: "claude",
  });
  return queued;
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

async function drain(queued: FollowupRun, overrides: Partial<FollowupRunnerParams> = {}) {
  const sessionKey = queued.run.sessionKey!;
  activeKeys.add(sessionKey);
  const completed = createDeferred();
  const runner = createFollowupRunner({
    typing: createTypingController(),
    typingMode: "never",
    defaultModel: "anthropic/claude",
    ...overrides,
  });
  expect(
    enqueueFollowupRun(
      sessionKey,
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
  expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
}

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

async function runPolicyRefreshScenario(sessionKey: string, refreshedPolicy: "allow" | "deny") {
  const sessionEntry: InternalSessionEntry = {
    sessionId: `${sessionKey}-session`,
    updatedAt: Date.now(),
    sendPolicy: "allow",
  };
  const queued = createQueuedRun(sessionKey);
  queued.run.sessionId = sessionEntry.sessionId;
  queued.run.config = { agents: { defaults: { compaction: { notifyUser: true } } } };
  state.preflight.mockImplementation(async (input) => {
    await input.onCompactionNotice?.("end", "Context compacted");
    sessionEntry.sendPolicy = refreshedPolicy;
    return sessionEntry;
  });
  await drain(queued, {
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
  });
}

it("releases the admitted operation when source adoption fails", async () => {
  const { executeFollowupTurn } = await vi.importActual<
    typeof import("./followup-turn-execution.js")
  >("./followup-turn-execution.js");
  state.execute.mockImplementation(executeFollowupTurn);
  const sessionKey = "agent:main:followup-adoption-failure";
  const queued = createQueuedRun(sessionKey);
  const failure = new Error("source adoption failed");
  const onAdopted = vi.fn().mockRejectedValue(failure);
  queued.turnAdoptionLifecycle = { onAdopted };
  await drain(queued);
  expect(state.execute).toHaveBeenCalledOnce();
  expect(onAdopted).toHaveBeenCalledOnce();
});

it("suppresses a deferred compaction notice after preflight refreshes policy to deny", async () => {
  await runPolicyRefreshScenario("agent:main:followup-policy-control", "allow");
  expect(state.deliver.mock.calls.filter(([params]) => params.kind === "block")).toHaveLength(1);

  state.deliver.mockClear();
  state.execute.mockClear();
  await runPolicyRefreshScenario("agent:main:followup-policy-refresh", "deny");
  expect(state.deliver.mock.calls.filter(([params]) => params.kind === "block")).toHaveLength(0);
  expect(state.execute).toHaveBeenCalledOnce();
});
