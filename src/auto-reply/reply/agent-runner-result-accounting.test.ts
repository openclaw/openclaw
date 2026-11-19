import { beforeEach, expect, it, vi } from "vitest";
import * as modelsConfig from "../../agents/models-config-state.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentTurnCompaction } from "./agent-runner-execution.types.js";
import {
  createDefaults,
  createSettledExecution,
  createTurn,
} from "./followup-delivery.test-helpers.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./reply-agent-turn-preparation.js";

const mocks = vi.hoisted(() => ({ refreshQueuedFollowupSession: vi.fn() }));
const state = vi.hoisted(() => ({
  dispatchPostCompactionDelegates: vi.fn(),
  emitContinuationCompactionReleasedSpan: vi.fn(),
  formatCurrentSpanContinuationTraceparent: vi.fn<() => string | undefined>(),
  incrementCompactionCount: vi.fn(),
  recordNoOpRearmOutcome: vi.fn(),
  scheduleContinuation: vi.fn(),
  resolveContinuationTraceparent: vi.fn<(value: string | undefined) => string | undefined>(),
}));

// mock-isolation: Queue accounting uses a fixed context limit without the process-wide model cache.
vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => 200_000,
}));

// mock-isolation: Continuation scheduling is recorded without persisting chain state or queuing work.
vi.mock("./agent-runner-continuation-schedule.js", () => ({
  scheduleReplyContinuation: (...args: unknown[]) => state.scheduleContinuation(...args),
}));

// mock-isolation: Compaction counts are recorded without writing the session store.
vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: (...args: unknown[]) => state.incrementCompactionCount(...args),
}));

vi.mock("./no-op-rearm-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./no-op-rearm-guard.js")>();
  return {
    ...actual,
    recordNoOpRearmOutcome: (...args: unknown[]) => state.recordNoOpRearmOutcome(...args),
    summarizeEmbeddedRunOutcome: () => ({
      hasVisibleReply: true,
      toolNames: [],
      structuredCompletion: false,
      errorOnlyNoGain: false,
    }),
  };
});

// mock-isolation: Delegate dispatch is recorded without the delivery queue or system events.
vi.mock("./post-compaction-delegate-dispatch.js", () => ({
  dispatchPostCompactionDelegates: (...args: unknown[]) =>
    state.dispatchPostCompactionDelegates(...args),
}));

// mock-isolation: Continuation spans are captured without the process-wide tracer.
vi.mock("../../infra/continuation-tracer.js", () => ({
  emitContinuationCompactionReleasedSpan: (...args: unknown[]) =>
    state.emitContinuationCompactionReleasedSpan(...args),
  formatCurrentSpanContinuationTraceparent: () => state.formatCurrentSpanContinuationTraceparent(),
  resolveContinuationTraceparent: (value: string | undefined) =>
    state.resolveContinuationTraceparent(value),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) => mocks.refreshQueuedFollowupSession(...args),
}));

vi.mock("./reply-usage-state.js", () => ({
  buildReplyUsageState: () => ({}),
  recordReplyUsageState: vi.fn(),
}));

import { accountFollowupTurn } from "./agent-runner-result-accounting.js";

// Callers arm continuation only after the terminal completion commits.
async function accountFollowupTurnAndSchedule(params: Parameters<typeof accountFollowupTurn>[0]) {
  const accounted = await accountFollowupTurn(params);
  await accounted?.scheduleContinuation();
  return accounted;
}

const continuationConfig = {
  agents: {
    defaults: {
      continuation: {
        enabled: true,
        maxChainLength: 10,
        defaultDelayMs: 15_000,
        minDelayMs: 5_000,
        maxDelayMs: 86_400_000,
        costCapTokens: 50_000,
        maxDelegatesPerTurn: 5,
      },
    },
  },
} satisfies OpenClawConfig;

function createContinuationTurn(): AdmittedFollowupTurn {
  let currentEntry: SessionEntry | undefined = {
    sessionId: "session-1",
    updatedAt: 1,
    pendingPostCompactionDelegates: [{ task: "release after compaction", createdAt: 1 }],
  };
  const sessionStore: Record<string, SessionEntry> = { main: currentEntry };
  return {
    runId: "run-1",
    queued: {
      prompt: "queued prompt",
      enqueuedAt: 1,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session-1",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: continuationConfig,
        provider: "anthropic",
        model: "claude",
        messageProvider: "discord",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: continuationConfig,
    sessionStore,
    session: {
      kind: "session",
      key: "main",
      current: () => currentEntry,
      publish: (entry) => {
        currentEntry = entry;
        if (entry) {
          sessionStore.main = entry;
        }
      },
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  };
}

function createExecution(
  overrides: {
    autoCompactionCount?: number;
    compaction?: AgentTurnCompaction;
    compactionTraceparent?: string;
    continueWorkRequests?: Array<{ reason: string; delaySeconds: number }>;
  } = {},
): FollowupExecutionResult {
  return {
    commentaryPayloadsEnabled: false,
    execution: {
      runId: "run-1",
      outcome: {
        kind: "settled",
        status: "ok",
        result: {
          payloads: [{ text: "done" }],
          meta: {
            durationMs: 0,
            agentMeta: {
              provider: "anthropic",
              model: "claude",
              sessionId: "session-1",
              usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
            },
          },
        },
        continueWorkRequests: overrides.continueWorkRequests ?? [
          { reason: "finish queued work", delaySeconds: 30 },
        ],
        compactionTraceparent: overrides.compactionTraceparent,
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: overrides.autoCompactionCount ?? 0,
        ...(overrides.compaction ? { compaction: overrides.compaction } : {}),
      },
    },
    runStartedAt: Date.now() - 10,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: {
      drain: vi.fn(async () => {}),
    },
  } as FollowupExecutionResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.dispatchPostCompactionDelegates.mockResolvedValue({
    queuedDelegates: 1,
    droppedDelegates: 0,
  });
  state.incrementCompactionCount.mockResolvedValue(7);
  state.scheduleContinuation.mockResolvedValue(undefined);
  state.formatCurrentSpanContinuationTraceparent.mockReturnValue(undefined);
  state.resolveContinuationTraceparent.mockReturnValue(undefined);
});

function createParams(
  authProfileOverrideCompactionCount?: number,
): Parameters<typeof accountFollowupTurn>[0] {
  const entry: SessionEntry = {
    sessionId: "session",
    updatedAt: 1,
    authProfileOverride: "openai:work",
    authProfileOverrideCompactionCount,
  };
  const turn = createTurn({
    session: {
      kind: "session",
      key: "main",
      current: () => entry,
      publish: () => {},
    },
  });
  const execution = createSettledExecution();
  execution.outcome.resolved = { provider: "openai", model: "gpt-4o" };
  return {
    turn,
    defaults: createDefaults(async () => {}),
    execution: {
      commentaryPayloadsEnabled: false,
      execution,
      runStartedAt: 1,
      sessionCtx: {},
      pendingToolTasks: new Set(),
      progress: { drain: async () => {} },
    },
  };
}

it("forwards queued continue_work requests into continuation scheduling", async () => {
  const turn = createContinuationTurn();
  const defaults = {
    typing: {} as FollowupRunnerParams["typing"],
    typingMode: "never",
    defaultModel: "anthropic/claude",
    opts: {},
  } satisfies FollowupRunnerParams;

  await accountFollowupTurnAndSchedule({
    turn,
    defaults,
    execution: createExecution(),
  });

  expect(state.scheduleContinuation).toHaveBeenCalledOnce();
  expect(state.recordNoOpRearmOutcome).not.toHaveBeenCalled();
  expect(state.scheduleContinuation).toHaveBeenCalledWith(
    expect.objectContaining({
      cfg: continuationConfig,
      sessionKey: "main",
      followupRun: turn.queued,
      runId: "run-1",
      usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
      effectiveContinuationSignal: expect.objectContaining({
        kind: "work",
        delayMs: 30_000,
      }),
      effectiveContinueWorkRequests: [{ reason: "finish queued work", delaySeconds: 30 }],
      continuationWorkReason: "finish queued work",
    }),
  );
});

it("prefers a delegate token retained only in raw terminal text over typed continue_work", async () => {
  const turn = createContinuationTurn();
  const currentTraceparent = "00-11111111111111111111111111111111-2222222222222222-01";
  const inheritedTraceparent = "00-11111111111111111111111111111111-3333333333333333-01";
  turn.queued.run.traceparent = inheritedTraceparent;
  state.formatCurrentSpanContinuationTraceparent.mockReturnValue(currentTraceparent);
  state.resolveContinuationTraceparent.mockReturnValue(inheritedTraceparent);
  const defaults = {
    typing: {} as FollowupRunnerParams["typing"],
    typingMode: "never",
    defaultModel: "anthropic/claude",
    opts: {},
  } satisfies FollowupRunnerParams;
  const execution = createExecution();
  if (execution.execution.outcome.kind !== "settled") {
    throw new Error("expected settled execution");
  }
  execution.execution.outcome.result.payloads = [{ text: "handoff queued" }];
  execution.execution.outcome.rawContinuationText =
    "handoff queued\n[[CONTINUE_DELEGATE: inspect followup state]]";

  await accountFollowupTurnAndSchedule({ turn, defaults, execution });

  expect(state.scheduleContinuation).toHaveBeenCalledWith(
    expect.objectContaining({
      effectiveContinuationSignal: expect.objectContaining({
        kind: "delegate",
        task: "inspect followup state",
      }),
      continuationExtractionFromBracket: true,
      effectiveContinueWorkRequests: [{ reason: "finish queued work", delaySeconds: 30 }],
      continuationWorkReason: undefined,
      internalBracketTraceparent: currentTraceparent,
    }),
  );
});

it.each([
  [undefined, "user"],
  [0, "auto"],
] as const)(
  "forwards a source-less pin with compaction count %s as %s during fallback queue refresh",
  async (authProfileOverrideCompactionCount, expectedSource) => {
    using preparation = vi.spyOn(modelsConfig, "captureModelsJsonCostSource");
    await accountFollowupTurn(createParams(authProfileOverrideCompactionCount));
    expect(preparation).not.toHaveBeenCalled();

    expect(mocks.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
    expect(mocks.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "main",
        nextProvider: "openai",
        nextModel: "gpt-4o",
        nextAuthProfileId: "openai:work",
        nextAuthProfileIdSource: expectedSource,
      }),
    );
  },
);

it("forwards a work token retained only in raw terminal text", async () => {
  const turn = createContinuationTurn();
  const defaults = {
    typing: {} as FollowupRunnerParams["typing"],
    typingMode: "never",
    defaultModel: "anthropic/claude",
    opts: {},
  } satisfies FollowupRunnerParams;
  const execution = createExecution({ continueWorkRequests: [] });
  if (execution.execution.outcome.kind !== "settled") {
    throw new Error("expected settled execution");
  }
  execution.execution.outcome.result.payloads = [{ text: "more remains" }];
  execution.execution.outcome.rawContinuationText = "more remains\n[[CONTINUE_WORK:45]]";

  await accountFollowupTurnAndSchedule({ turn, defaults, execution });

  expect(state.scheduleContinuation).toHaveBeenCalledWith(
    expect.objectContaining({
      effectiveContinuationSignal: { kind: "work", delayMs: 45_000 },
      continuationExtractionFromBracket: true,
      continuationWorkReason: undefined,
    }),
  );
});

it("does not recover a non-terminal delegate token from raw text", async () => {
  const turn = createContinuationTurn();
  const defaults = {
    typing: {} as FollowupRunnerParams["typing"],
    typingMode: "never",
    defaultModel: "anthropic/claude",
    opts: {},
  } satisfies FollowupRunnerParams;
  const execution = createExecution({ continueWorkRequests: [] });
  if (execution.execution.outcome.kind !== "settled") {
    throw new Error("expected settled execution");
  }
  execution.execution.outcome.result.payloads = [{ text: "final answer" }];
  execution.execution.outcome.rawContinuationText =
    "[[CONTINUE_DELEGATE: stale task]]\nfinal answer";

  await accountFollowupTurnAndSchedule({ turn, defaults, execution });

  expect(state.scheduleContinuation).toHaveBeenCalledWith(
    expect.objectContaining({
      effectiveContinuationSignal: null,
      continuationExtractionFromBracket: false,
    }),
  );
});

it("does not recover selected raw text when the settled fallback result is replay-unsafe", async () => {
  const turn = createContinuationTurn();
  const defaults = {
    typing: {} as FollowupRunnerParams["typing"],
    typingMode: "never",
    defaultModel: "anthropic/claude",
    opts: {},
  } satisfies FollowupRunnerParams;
  const execution = createExecution({ continueWorkRequests: [] });
  if (execution.execution.outcome.kind !== "settled") {
    throw new Error("expected settled execution");
  }
  execution.execution.outcome.result.payloads = [{ text: "partial" }];
  execution.execution.outcome.result.meta.error = {
    kind: "incomplete_turn",
    message: "latest fallback interrupted",
  };
  execution.execution.outcome.result.meta.replayInvalid = true;
  execution.execution.outcome.rawContinuationText =
    "preferred\n[[CONTINUE_DELEGATE: stale selected task]]";

  await accountFollowupTurnAndSchedule({ turn, defaults, execution });

  expect(state.scheduleContinuation).toHaveBeenCalledWith(
    expect.objectContaining({
      effectiveContinuationSignal: null,
      continuationExtractionFromBracket: false,
      effectiveContinueWorkRequests: [],
    }),
  );
});

it("releases staged delegates before scheduling same-turn post-compaction work", async () => {
  const turn = createContinuationTurn();
  const defaults = {
    typing: {} as FollowupRunnerParams["typing"],
    typingMode: "never",
    defaultModel: "anthropic/claude",
    opts: {},
  } satisfies FollowupRunnerParams;
  const order: string[] = [];
  state.dispatchPostCompactionDelegates.mockImplementation(async () => {
    order.push("release");
    return { queuedDelegates: 1, droppedDelegates: 0 };
  });
  state.scheduleContinuation.mockImplementation(async () => {
    order.push("schedule");
  });

  await accountFollowupTurnAndSchedule({
    turn,
    defaults,
    execution: createExecution({
      autoCompactionCount: 1,
      compaction: {
        count: 1,
        durable: [
          {
            kind: "durable",
            count: 1,
            currentContextSnapshot: { tokens: 100 },
            target: {
              agentId: "agent",
              sessionId: "session-1",
              sessionKey: "main",
              storePath: "/tmp/sessions.json",
            },
          },
        ],
      },
      compactionTraceparent: "00-trace",
    }),
  });

  expect(order).toEqual(["release", "schedule"]);
  expect(state.dispatchPostCompactionDelegates).toHaveBeenCalledWith(
    expect.objectContaining({
      cfg: continuationConfig,
      compactionCount: 7,
      continuationSignalKind: "work",
      followupRun: turn.queued,
      releaseTraceparent: "00-trace",
      sessionKey: "main",
      sessionStore: turn.sessionStore,
    }),
  );
  expect(state.emitContinuationCompactionReleasedSpan).toHaveBeenCalledWith({
    releasedCount: 1,
    compactionId: 7,
    traceparent: "00-trace",
    log: expect.any(Function),
  });
});

it("reports the custody-staged delegates the release queued as compaction.released", async () => {
  const turn = createContinuationTurn();
  // Lifeboats staged through custody never enter the entry's legacy pending list.
  delete turn.session.current()?.pendingPostCompactionDelegates;
  state.dispatchPostCompactionDelegates.mockResolvedValue({
    queuedDelegates: 2,
    droppedDelegates: 0,
  });

  await accountFollowupTurnAndSchedule({
    turn,
    defaults: {
      typing: {} as FollowupRunnerParams["typing"],
      typingMode: "never",
      defaultModel: "anthropic/claude",
      opts: {},
    },
    execution: createExecution({
      autoCompactionCount: 1,
      compaction: {
        count: 1,
        durable: [
          {
            kind: "durable",
            count: 1,
            currentContextSnapshot: { tokens: 100 },
            target: {
              agentId: "agent",
              sessionId: "session-1",
              sessionKey: "main",
              storePath: "/tmp/sessions.json",
            },
          },
        ],
      },
      compactionTraceparent: "00-trace",
    }),
  });

  expect(state.emitContinuationCompactionReleasedSpan).toHaveBeenCalledWith(
    expect.objectContaining({ releasedCount: 2, compactionId: 7 }),
  );
});
