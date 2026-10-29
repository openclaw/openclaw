import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { runEmbeddedAttempt } from "../../agents/embedded-agent-runner/run/attempt.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { createOpenClawAgentHarness } from "../../agents/harness/builtin-openclaw.js";
import {
  createAttemptParams,
  createAttemptResult,
} from "../../agents/harness/lifecycle.test-support.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import type { WorkerSessionPlacementRecord } from "../../gateway/worker-environments/placement-record.js";
import { localPlacement } from "../../gateway/worker-environments/placement-suite.test-support.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import {
  sessionControllerMailboxes,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../sessions/session-controller.stop.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { mintReplyMessageActionTurnCapability } from "./agent-runner-utils.js";
import {
  bindGoalContinuationExecution,
  promoteGoalContinuationYield,
  withGoalContinuationSettlement,
  readGoalContinuationContext,
  prepareGoalContinuationContext,
  recordGoalContinuationSettlement,
  finishGoalContinuationSettlement,
  revokeGoalContinuationReturn,
} from "./goal-continuation-return.js";
import {
  enqueueGoalContinuation,
  isGoalContinuationCurrent,
  isGoalContinuationPlacementCurrent,
  createGoalContinuationReturn,
} from "./goal-continuation.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue/enqueue.js";
import type { FollowupRun } from "./queue/types.js";

// mock-isolation: This unit contract observes the actual built-in context consumer without a provider call.
vi.mock("../../agents/embedded-agent-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: vi.fn(async () => createAttemptResult()),
}));

const children = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
// mock-isolation: Child custody is supplied without restoring the process registry.
vi.mock("../../agents/subagents/registry/subagent-registry.js", () => ({
  listUnsettledRequesterChildren: children,
}));

// mock-isolation: This owner test controls worker publications without opening a database.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: vi.fn(),
}));
// mock-isolation: Queue insertion is observed here; real draining is covered by server.chat-goal.
vi.mock("./queue/enqueue.js", () => ({
  enqueueFollowupRun: vi.fn(() => true),
  getFollowupQueueDepth: vi.fn(() => 0),
}));

const workerPlacement = vi.hoisted(() => ({
  current: vi.fn<() => WorkerSessionPlacementRecord | undefined>(),
  supported: true,
}));
// mock-isolation: The live Gateway owner supplies placement facts; RPC proof uses SQLite.
vi.mock("../../plugins/runtime/gateway-request-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime/gateway-request-scope.js")>()),
  getInProcessGatewayRequestContext: () => ({
    workerSessionPlacementService: {
      prepareSessionPlacement: async () => ({
        prepareRead: () => undefined,
        current: workerPlacement.current,
        release: () => {},
      }),
    },
  }),
}));
// mock-isolation: Only the installed harness's remote-exec support is variable here.
vi.mock("../../agents/harness/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/harness/registry.js")>()),
  getRegisteredAgentHarness: () =>
    workerPlacement.supported
      ? {
          harness: {
            id: "codex",
            label: "Codex",
            cloudPlacement: { mode: "remote-exec" },
            supports: () => ({ supported: true }),
            runAttempt: async () => normal,
          },
        }
      : undefined,
}));

const identity = {
  sessionId: "goal-session",
  lifecycleRevision: "revision-2",
  goalId: "goal-1",
};
const normal: EmbeddedAgentRunResult = {
  meta: { durationMs: 0, stopReason: "end_turn" },
  payloads: [{ text: "More work remains." }],
};
const operations = new Set<ReplyOperation>();
function entry(): SessionEntry {
  return {
    sessionId: identity.sessionId,
    lifecycleRevision: "revision-2",
    updatedAt: 2000,
    goal: {
      schemaVersion: 1,
      id: identity.goalId,
      status: "active",
      objective: "Finish the checklist",
      createdAt: 1000,
      updatedAt: 1000,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    },
  };
}
function fixture() {
  const controller = new AbortController();
  const operation = createReplyOperation({
    sessionKey: "agent:main:goal",
    sessionId: identity.sessionId,
    resetTriggered: false,
    upstreamAbortSignal: controller.signal,
  });
  operations.add(operation);
  const base: FollowupRun = {
    prompt: "Initial user request",
    enqueuedAt: 1000,
    abortSignal: controller.signal,
    run: {
      agentId: "main",
      agentDir: "/fixture",
      sessionId: identity.sessionId,
      sessionKey: "agent:main:goal",
      sessionFile: "agent:main:goal",
      workspaceDir: "/fixture",
      config: {},
      provider: "test",
      model: "test",
      timeoutMs: 10000,
      blockReplyBreak: "text_end",
    },
  };
  const params: Parameters<typeof enqueueGoalContinuation>[0] = {
    base,
    result: normal,
    initialGoalId: identity.goalId,
    expectedSession: identity,
    sessionKey: "agent:main:goal",
    storePath: "/fixture/sessions.json",
    queueKey: "agent:main:goal",
    settings: { mode: "followup", debounceMs: 0 },
    sourceRunId: "run-1",
    operation,
    runFollowup: vi.fn(async () => {}),
  };
  return { params, controller, operation };
}
beforeEach(() => {
  vi.useFakeTimers();
  children.mockResolvedValue([]);
  workerPlacement.supported = true;
  workerPlacement.current.mockReset();
  vi.mocked(enqueueFollowupRun).mockClear();
  vi.mocked(getFollowupQueueDepth).mockReturnValue(0);
  vi.mocked(readSessionEntryReadOnlyInWorker).mockResolvedValue(entry());
});
afterEach(async () => {
  for (const mailbox of sessionControllerMailboxes()) {
    if (mailbox.key === "agent:main:goal") {
      const inputs = [...mailbox.entries];
      inputs.forEach(retireSessionControllerInput);
      await Promise.all(inputs.map((input) => input.settlement.promise));
    }
  }
  try {
    for (const operation of operations) {
      operation.complete();
    }
    await Promise.all([...operations].map((operation) => operation.ownerSettlement));
  } finally {
    operations.clear();
    vi.useRealTimers();
  }
});

describe("Goal continuation eligibility", () => {
  it.each([
    "remote-exec",
    "local",
    "worker-turn",
    "wrong-session",
    "unsupported",
    "no-authority",
  ] as const)("binds Codex continuation to supported placement facts (%s)", async (mode) => {
    const f = fixture();
    f.params.base.operatorAuthority = {
      profileId: "operator",
      scopes: ["operator.admin"],
      assertCurrent: () => {},
    };
    if (mode === "no-authority") {
      f.params.base.operatorAuthority = undefined;
    }
    vi.mocked(readSessionEntryReadOnlyInWorker).mockResolvedValue({
      ...entry(),
      agentHarnessId: "codex",
    });
    workerPlacement.supported = mode !== "unsupported";
    workerPlacement.current.mockReturnValue({
      ...localPlacement(identity.sessionId),
      agentId: "main",
      sessionKey: mode === "wrong-session" ? "other" : f.params.sessionKey,
      sessionId: identity.sessionId,
      state: mode === "local" ? "local" : "requested",
      executionMode: mode === "worker-turn" ? "worker-turn" : "remote-exec",
    });
    expect(await enqueueGoalContinuation(f.params)).toBe(
      mode === "remote-exec" || mode === "local",
    );
    if (mode === "remote-exec") {
      expect(vi.mocked(enqueueFollowupRun).mock.calls[0]![1].goalContinuation).toEqual({
        ...identity,
        workerGoal: true,
      });
    } else if (mode === "local") {
      expect(vi.mocked(enqueueFollowupRun).mock.calls[0]![1].goalContinuation).toEqual({
        ...identity,
        localCodexGoal: true,
      });
    } else {
      expect(enqueueFollowupRun).not.toHaveBeenCalled();
    }
  });
  it.each(["local", "worker-required", "no-authority", "revoked"] as const)(
    "admits unplaced Codex goals only with current local authority (%s)",
    async (mode) => {
      const f = fixture();
      vi.mocked(readSessionEntryReadOnlyInWorker).mockResolvedValue({
        ...entry(),
        agentHarnessId: "codex",
      });
      workerPlacement.current.mockReturnValue(undefined);
      if (mode !== "no-authority") {
        f.params.base.operatorAuthority = {
          profileId: "operator",
          scopes: ["operator.admin"],
          assertCurrent: () => {
            if (mode === "revoked") {
              throw new Error("operator revoked");
            }
          },
        };
      }
      if (mode === "worker-required") {
        f.params.base.run.config = { cloudWorkers: { requiredProfile: "worker" } };
      }
      if (mode === "revoked") {
        await expect(enqueueGoalContinuation(f.params)).rejects.toThrow("operator revoked");
      } else {
        expect(await enqueueGoalContinuation(f.params)).toBe(mode === "local");
      }
      expect(enqueueFollowupRun).toHaveBeenCalledTimes(mode === "local" ? 1 : 0);
    },
  );
  it.each([
    { marker: "local", current: "local", expected: true },
    { marker: "local", current: "worker", expected: false },
    { marker: "worker", current: "local", expected: false },
    { marker: "worker", current: "worker", expected: true },
  ] as const)(
    "revalidates $marker Codex placement at admission when current is $current",
    async ({ marker, current, expected }) => {
      workerPlacement.current.mockReturnValue({
        agentId: "main",
        sessionKey: "agent:main:goal",
        sessionId: identity.sessionId,
        state: current === "local" ? "local" : "requested",
        executionMode: "remote-exec",
        generation: 1,
        turnClaim: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        environmentId: null,
        activeOwnerEpoch: null,
        workspaceBaseManifestRef: null,
        remoteWorkspaceDir: null,
        workerBundleHash: null,
        lastTranscriptAckCursor: null,
        lastLiveEventAckCursor: null,
        terminalReason: null,
        terminalAtMs: null,
        recoveryError: null,
      });
      const continuation = {
        ...identity,
        ...(marker === "worker"
          ? { workerGoal: true as const }
          : { localCodexGoal: true as const }),
      };
      await expect(
        isGoalContinuationPlacementCurrent({
          continuation,
          agentId: "main",
          sessionKey: "agent:main:goal",
          hasOperatorAuthority: true,
          requiresWorker: false,
        }),
      ).resolves.toBe(expected);
    },
  );
  it("rejects a queued local continuation when current policy requires a worker", async () => {
    await expect(
      isGoalContinuationPlacementCurrent({
        continuation: { ...identity, localCodexGoal: true },
        agentId: "main",
        sessionKey: "agent:main:goal",
        hasOperatorAuthority: true,
        requiresWorker: true,
      }),
    ).resolves.toBe(false);
  });
  it("does not resume paused goals", () => {
    const current = entry();
    current.goal!.status = "paused";
    expect(isGoalContinuationCurrent(identity, current)).toBe(false);
  });
  it("rejects replaced, cleared, reset, stopped and external-runtime sessions", () => {
    const current = entry();
    expect(isGoalContinuationCurrent(identity, current)).toBe(true);
    expect(isGoalContinuationCurrent(identity, undefined)).toBe(false);
    expect(isGoalContinuationCurrent(identity, { ...current, goal: undefined })).toBe(false);
    expect(isGoalContinuationCurrent(identity, { ...current, sessionId: "replacement" })).toBe(
      false,
    );
    expect(
      isGoalContinuationCurrent(identity, { ...current, lifecycleRevision: "revision-3" }),
    ).toBe(false);
    expect(isGoalContinuationCurrent(identity, { ...current, abortedLastRun: true })).toBe(false);
    expect(isGoalContinuationCurrent(identity, { ...current, agentHarnessId: "codex" })).toBe(
      false,
    );
    expect(
      isGoalContinuationCurrent(
        { ...identity, localCodexGoal: true },
        { ...current, agentHarnessId: "codex" },
      ),
    ).toBe(true);
    expect(isGoalContinuationCurrent(identity, { ...current, agentHarnessId: "external" })).toBe(
      false,
    );
    expect(
      isGoalContinuationCurrent(identity, {
        ...current,
        goal: { ...current.goal!, id: "new-goal" },
      }),
    ).toBe(false);
    expect(
      isGoalContinuationCurrent(identity, {
        ...current,
        goal: { ...current.goal!, updatedAt: 3000 },
      }),
    ).toBe(true);
  });
  it("observes fresh token exhaustion before scheduling another turn", () => {
    const current = entry();
    current.goal!.tokenBudget = 50;
    current.totalTokens = 50;
    current.totalTokensFresh = true;
    current.totalTokensVersion = 1;
    expect(isGoalContinuationCurrent(identity, current)).toBe(false);
    expect(current.goal!.status).toBe("active");
  });
  it.each([
    { aborted: true },
    { yielded: true },
    { continuationPending: true as const },
    { timeoutPhase: "provider" as const },
    { error: { kind: "hook_block" as const, message: "Blocked" } },
    { pendingToolCalls: [{ id: "tool-1", name: "exec", arguments: "{}" }] },
    { stopReason: "refusal" },
  ])("preserves an existing continuation or failure owner: %j", async (meta) => {
    const f = fixture();
    f.params.result = { ...normal, meta: { ...normal.meta, ...meta } };
    expect(await enqueueGoalContinuation(f.params)).toBe(false);
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
  });
  it("does not nudge deterministic approval prompts or returned errors", async () => {
    const f = fixture();
    f.params.result = { ...normal, didSendDeterministicApprovalPrompt: true };
    expect(await enqueueGoalContinuation(f.params)).toBe(false);
    f.params.result = { ...normal, payloads: [{ text: "failed", isError: true }] };
    expect(await enqueueGoalContinuation(f.params)).toBe(false);
  });
});

describe("Goal queue custody", () => {
  it("queues hidden individual work without cloning the source turn's identity or lifecycle", async () => {
    const f = fixture();
    f.params.base.sourceTurnId = "accepted-source";
    f.params.base.turnAdoptionLifecycle = { onAdopted: () => {} };
    expect(await enqueueGoalContinuation(f.params)).toBe(true);
    const queued = vi.mocked(enqueueFollowupRun).mock.calls[0]![1];
    expect(queued.prompt).toContain("Advance");
    expect(queued.goalContinuation).toEqual(identity);
    expect(queued.sourceTurnId).toBeUndefined();
    expect(queued.turnAdoptionLifecycle).toBeUndefined();
    expect(queued.disableCollectBatching).toBe(true);
    expect(queued.run.suppressNextUserMessagePersistence).toBe(true);
    expect(queued.run.inputProvenance?.sourceTool).toBe("session_goal_continue");
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]!.slice(3, 6)).toEqual([
      "message-id",
      f.params.runFollowup,
      false,
    ]);
    f.operation.complete();
    expect(queued.abortSignal?.aborted).toBe(false);
  });
  it.each([
    { source: "a user turn", event: undefined },
    { source: "a background completion", event: {} },
    { source: "a silent completion", event: { deliver: false } },
  ] as const)("binds channel-turn authority only for successors of $source", async ({ event }) => {
    const f = fixture();
    const { base } = f.params;
    Object.assign(base.run, { messageProvider: "discord", agentAccountId: "default" });
    Object.assign(base, { originatingChannel: "discord", originatingTo: "channel:123" });
    if (event) {
      base.run.internalEventExecution = { ...event, onStarted: vi.fn(), onTerminal: vi.fn() };
    }
    expect(await enqueueGoalContinuation(f.params)).toBe(true);
    const queued = vi.mocked(enqueueFollowupRun).mock.calls[0]![1];
    const runId = "goal-successor";
    const sessionCtx = { Provider: "discord", To: "channel:123", AccountId: "default" };
    const token = mintReplyMessageActionTurnCapability(
      { followupRun: queued, sessionCtx, opts: { runId } },
      runId,
    );
    try {
      const lookup = { token, agentId: "main", runId, sessionKey: "agent:main:goal" };
      Object.assign(lookup, { sessionId: identity.sessionId });
      if (event) {
        // The event's captured route never becomes current-conversation authority.
        expect(token).toBeUndefined();
        expect(queued.run.internalEventExecution).toBeUndefined();
        expect(queued.run.sessionEventOrigin).toEqual(event);
      } else {
        expect(resolveMessageActionTurnCapability(lookup)).toMatchObject({
          toolContext: { currentChannelProvider: "discord", currentChannelId: "channel:123" },
        });
        const otherSession = { ...lookup, sessionKey: "agent:main:other" };
        expect(resolveMessageActionTurnCapability(otherSession)).toBeUndefined();
        revokeMessageActionTurnCapability(token);
        expect(resolveMessageActionTurnCapability(lookup)).toBeUndefined();
      }
    } finally {
      revokeMessageActionTurnCapability(token);
    }
  });
  it("leaves announcing children from earlier turns with their continuation owner", async () => {
    const f = fixture();
    children.mockResolvedValue([{ runId: "earlier-child" }]);
    expect(await enqueueGoalContinuation(f.params)).toBe(false);
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
  });
  it("allocates each successor before settling the previous one-shot delivery", async () => {
    const delivered = vi.fn(async () => ({ kind: "delivered" as const }));
    const source = createChatSendLateFollowupDisposition({
      runId: "source",
      originatingChannel: "webchat",
      logGateway: createSubsystemLogger("goal-test"),
      deliver: delivered,
    });
    const first = fixture();
    first.params.base.originatingChannel = "webchat";
    first.params.base.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source.deliver };
    await enqueueGoalContinuation(first.params);
    let current = vi.mocked(enqueueFollowupRun).mock.calls.at(-1)![1];
    first.operation.complete();
    for (let index = 0; index < 3; index++) {
      const f = fixture();
      f.params.base = current;
      f.params.sourceRunId = "continuation-" + index;
      expect(await enqueueGoalContinuation(f.params)).toBe(true);
      const next = vi.mocked(enqueueFollowupRun).mock.calls.at(-1)![1];
      if (current.queuedFollowupReplyDisposition?.kind !== "deliver") {
        throw new Error("Missing delivery owner");
      }
      await current.queuedFollowupReplyDisposition.deliver({
        kind: "queued-followup",
        runId: f.params.sourceRunId,
        originatingChannel: "webchat",
        payloads: [{ text: "Progress" }],
        completion: { kind: "completed" },
      });
      f.operation.complete();
      current = next;
    }
    expect(delivered).toHaveBeenCalledTimes(3);
  });
  it.each(["stop", "new input", "goal replacement"])(
    "rechecks %s after the worker read yields",
    async (change) => {
      const f = fixture();
      const read = createDeferred<SessionEntry | undefined>();
      vi.mocked(readSessionEntryReadOnlyInWorker).mockReturnValue(read.promise);
      const pending = enqueueGoalContinuation(f.params);
      const current = entry();
      if (change === "stop") {
        f.controller.abort();
      }
      if (change === "new input") {
        vi.mocked(getFollowupQueueDepth).mockReturnValue(1);
      }
      if (change === "goal replacement") {
        current.goal!.id = "new-goal";
      }
      read.resolve(current);
      expect(await pending).toBe(false);
      expect(enqueueFollowupRun).not.toHaveBeenCalled();
    },
  );
  it("invalidates an enqueued nudge when source delivery subsequently fails", async () => {
    const f = fixture();
    await enqueueGoalContinuation(f.params);
    const queued = vi.mocked(enqueueFollowupRun).mock.calls[0]![1];
    f.operation.fail("run_failed", new Error("delivery failed"));
    f.operation.complete();
    expect(queued.abortSignal?.aborted).toBe(true);
  });
});

function retainedGoal(existingChild?: SubagentRunRecord) {
  const f = fixture();
  const child: SubagentRunRecord = existingChild ?? {
    runId: "goal-child",
    childSessionKey: "agent:main:subagent:goal-child",
    childAgentId: "main",
    requesterSessionKey: f.params.sessionKey,
    requesterAgentId: "main",
    requesterDisplayKey: f.params.sessionKey,
    task: "Verify the first item",
    cleanup: "keep",
    createdAt: 1000,
    execution: { status: "terminal", endedAt: 1100, outcome: { status: "ok" } },
    completionRequesterSessionId: identity.sessionId,
    completionRequesterLifecycleRevision: identity.lifecycleRevision,
    requesterSettleWake: {
      status: "dispatching",
      attemptCount: 1,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: ["goal-child"],
    },
  };
  const publish = (
    verifiedSettlement = true,
    runId = "settle-run",
    result = normal,
    succeeded = true,
  ) =>
    withGoalContinuationSettlement(
      [child],
      "settle-run",
      () => true,
      () => {
        if (verifiedSettlement) {
          prepareGoalContinuationContext({
            runId,
            sessionKey: f.params.sessionKey,
            sessionEntry: entry(),
          });
        }
        const context = readGoalContinuationContext({ runId, sessionKey: f.params.sessionKey });
        recordGoalContinuationSettlement({
          runId,
          sessionKey: f.params.sessionKey,
          result,
          succeeded,
        });
        return context;
      },
    );
  const retain = () =>
    createGoalContinuationReturn(f.params)(() => {
      bindGoalContinuationExecution(f.params.sourceRunId, f.params.sessionKey);
      promoteGoalContinuationYield({
        requesterTurnRunId: f.params.sourceRunId,
        entries: [child],
        rearmGeneration: child.requesterSettleWake?.rearmGeneration,
      });
    });
  return {
    ...f,
    child,
    retain,
    publish,
    finish: (delivered = true) => finishGoalContinuationSettlement([child], delivered),
  };
}

describe("Goal return from committed child custody", () => {
  it.each(["settle-run", "independent-command"])(
    "injects Goal context at the actual built-in harness only for the admitted settlement (%s)",
    async (runId) => {
      const f = retainedGoal();
      f.retain();
      await withGoalContinuationSettlement(
        [f.child],
        "settle-run",
        () => true,
        async () => {
          prepareGoalContinuationContext({
            runId: "settle-run",
            sessionKey: f.params.sessionKey,
            sessionEntry: entry(),
          });
          vi.mocked(runEmbeddedAttempt).mockClear();
          await createOpenClawAgentHarness().runAttempt({
            ...createAttemptParams(),
            runId,
            sessionKey: f.params.sessionKey,
            currentInboundContext: { text: "Preserve the requester context." },
          });
          const context = vi.mocked(runEmbeddedAttempt).mock.calls[0]?.[0].currentInboundContext;
          expect(context?.text).toContain("Preserve the requester context.");
          expect(context?.text.includes("Active goal: Finish the checklist")).toBe(
            runId === "settle-run",
          );
        },
      );
      await f.finish(false);
    },
  );

  it("keeps the original route and independently retained operator restriction until queue handoff", async () => {
    const f = retainedGoal();
    let holds = 1;
    const source = createAdmittedRunOperatorAuthority({
      profileId: "goal-owner",
      scopes: ["operator.write"],
      assertCurrent() {
        if (!holds) {
          throw new Error("source released");
        }
      },
      retain() {
        holds++;
        return () => {
          holds--;
        };
      },
    });
    f.params.base.operatorAuthority = source;
    f.params.base.originatingThreadId = "original-thread";
    f.params.base.originatingChannel = "webchat";
    const delivered = vi.fn(async () => ({ kind: "delivered" as const }));
    const sourceReply = createChatSendLateFollowupDisposition({
      runId: "source",
      originatingChannel: "webchat",
      logGateway: createSubsystemLogger("goal-return-test"),
      deliver: delivered,
    });
    sourceReply.recordQueued();
    f.params.base.queuedFollowupReplyDisposition = {
      kind: "deliver",
      deliver: sourceReply.deliver,
    };
    f.retain();
    await sourceReply.deliver({
      kind: "queued-followup",
      runId: "source",
      originatingChannel: "webchat",
      payloads: [],
      completion: { kind: "completed" },
    });
    f.operation.complete();
    holds--; // The original chat input has settled, but child custody is independent.
    expect(holds).toBe(1);
    expect(f.publish()?.text).toContain("Active goal: Finish the checklist");
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
    await f.finish();
    const queued = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(queued?.originatingThreadId).toBe("original-thread");
    expect(queued?.operatorAuthority).toBe(source);
    expect(queued?.goalContinuation).toEqual(identity);
    if (queued?.queuedFollowupReplyDisposition?.kind !== "deliver") {
      throw new Error("Goal lost its original reply route");
    }
    await queued.queuedFollowupReplyDisposition.deliver({
      kind: "queued-followup",
      runId: "goal-nudge",
      originatingChannel: "webchat",
      payloads: [{ text: "Checklist work continued" }],
      completion: { kind: "completed" },
    });
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(holds).toBe(0);
    await f.finish();
    expect(enqueueFollowupRun).toHaveBeenCalledOnce();
  });

  it("does not lend a chat Goal to a different command executing in inherited context", async () => {
    const f = retainedGoal();
    createGoalContinuationReturn(f.params)(() => {
      bindGoalContinuationExecution(f.params.sourceRunId, f.params.sessionKey);
      promoteGoalContinuationYield({
        requesterTurnRunId: "independent-command",
        entries: [f.child],
        rearmGeneration: 1,
      });
    });
    expect(f.publish()).toBeUndefined();
    await f.finish();
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
  });

  it("cancels the retained return when Stop arrives while children own the turn", async () => {
    const f = retainedGoal();
    f.retain();
    f.operation.complete();
    f.controller.abort();
    expect(f.publish()).toBeUndefined();
    await f.finish();
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
  });

  it("does not carry a revoked settle capability into context or terminal publication", async () => {
    const f = retainedGoal();
    f.retain();
    f.operation.complete();
    let current = true;
    withGoalContinuationSettlement(
      [f.child],
      "settle-run",
      () => current,
      () => {
        prepareGoalContinuationContext({
          runId: "settle-run",
          sessionKey: f.params.sessionKey,
          sessionEntry: entry(),
        });
        current = false;
        expect(
          readGoalContinuationContext({ runId: "settle-run", sessionKey: f.params.sessionKey }),
        ).toBeUndefined();
        recordGoalContinuationSettlement({
          runId: "settle-run",
          sessionKey: f.params.sessionKey,
          result: normal,
          succeeded: true,
        });
      },
    );
    await f.finish();
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
  });

  it("releases an obsolete return when a newer requester owns the same child cohort", async () => {
    const first = retainedGoal();
    const release = vi.fn();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "goal-owner",
      scopes: ["operator.write"],
      assertCurrent() {},
      retain: () => release,
    });
    first.params.base.operatorAuthority = authority;
    first.retain();
    first.operation.complete();
    const next = retainedGoal(first.child);
    next.params.sourceRunId = "new-source-run";
    next.params.base.operatorAuthority = authority;
    next.retain();
    expect(release).toHaveBeenCalledOnce();
    next.operation.complete();
    next.publish();
    await next.finish();
    expect(release).toHaveBeenCalledTimes(2);
    expect(enqueueFollowupRun).toHaveBeenCalledOnce();
  });

  it.each(["settle-run", "new-attempt"])(
    "reuses only the exact terminal command receipt on transport replay (%s)",
    async (runId) => {
      const f = retainedGoal();
      f.retain();
      f.operation.complete();
      f.publish();
      withGoalContinuationSettlement(
        [f.child],
        runId,
        () => true,
        () => {},
      );
      await f.finish();
      expect(enqueueFollowupRun).toHaveBeenCalledTimes(runId === "settle-run" ? 1 : 0);
    },
  );

  it.each([
    "paused",
    "blocked",
    "complete",
    "usage_limited",
    "budget_limited",
    "cleared",
    "replaced",
    "reset",
    "stopped",
  ] as const)("rechecks %s after the command final and batch commit", async (change) => {
    const f = retainedGoal();
    f.retain();
    f.operation.complete();
    f.publish();
    const current = entry();
    if (change === "cleared") {
      current.goal = undefined;
    } else if (change === "replaced") {
      current.goal!.id = "new-goal";
    } else if (change === "reset") {
      current.lifecycleRevision = "new-revision";
    } else if (change === "stopped") {
      current.abortedLastRun = true;
    } else {
      current.goal!.status = change;
    }
    vi.mocked(readSessionEntryReadOnlyInWorker).mockResolvedValue(current);
    await f.finish();
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
  });

  it.each([
    "queued input",
    "unsettled sibling",
    "delivery failure",
    "command failure",
    "timeout",
    "yield",
    "unverified command",
    "different run",
  ])("does not turn %s into autonomous command work", async (boundary) => {
    const f = retainedGoal();
    f.retain();
    f.operation.complete();
    const result =
      boundary === "timeout"
        ? { ...normal, meta: { ...normal.meta, timeoutPhase: "provider" as const } }
        : boundary === "yield"
          ? { ...normal, meta: { ...normal.meta, yielded: true } }
          : normal;
    f.publish(
      boundary !== "unverified command",
      boundary === "different run" ? "other-run" : "settle-run",
      result,
      boundary !== "command failure" && boundary !== "unverified command",
    );
    if (boundary === "queued input") {
      vi.mocked(getFollowupQueueDepth).mockReturnValue(1);
    }
    if (boundary === "unsettled sibling") {
      children.mockResolvedValue([{ runId: "sibling" }]);
    }
    await f.finish(boundary !== "delivery failure");
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
  });

  it.each(["Stop", "source retirement", "operator revocation"])(
    "checks %s again after asynchronous final enqueue preparation",
    async (boundary) => {
      const f = retainedGoal();
      const revoked = new AbortController();
      let current = true;
      f.params.base.operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "goal-owner",
        scopes: ["operator.write"],
        signal: revoked.signal,
        assertCurrent() {
          if (!current) {
            throw new Error("revoked");
          }
        },
      });
      f.retain();
      f.operation.complete();
      f.publish();
      const readStarted = createDeferred();
      const read = createDeferred<SessionEntry | undefined>();
      vi.mocked(readSessionEntryReadOnlyInWorker).mockImplementation(() => {
        readStarted.resolve();
        return read.promise;
      });
      const finishing = f.finish();
      await readStarted.promise;
      let stopped: ReturnType<typeof stopSession> | undefined;
      if (boundary === "Stop") {
        const capture = captureSessionControllerStop({
          targets: [
            captureSessionTarget({
              storeScope: f.params.storePath,
              sessionKey: f.params.sessionKey,
              agentId: f.params.base.run.agentId,
              incarnation: identity.sessionId,
            }),
          ],
        });
        expect(capture.queuedInputs).toHaveLength(1);
        stopped = stopSession({
          source: "client-session",
          capture,
          hookContext: { sessionKey: f.params.sessionKey },
        });
        expect(await stopped.completed).toMatchObject({ queuedCancelled: 1 });
        expect(f.controller.signal.aborted).toBe(false);
      }
      if (boundary === "source retirement") {
        revokeGoalContinuationReturn(f.child);
      }
      if (boundary === "operator revocation") {
        current = false;
        revoked.abort();
      }
      read.resolve(entry());
      await finishing;
      await stopped?.settled;
      expect(enqueueFollowupRun).not.toHaveBeenCalled();
    },
  );
});
