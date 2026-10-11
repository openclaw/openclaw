import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { enqueueGoalContinuation, isGoalContinuationCurrent } from "./goal-continuation.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue/enqueue.js";
import type { FollowupRun } from "./queue/types.js";
import { createReplyOperation } from "./reply-run-registry.operation.js";
import { testing } from "./reply-run-registry.test-support.js";

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

const identity = {
  sessionId: "goal-session",
  lifecycleRevision: "revision-2",
  goalId: "goal-1",
};
const normal: EmbeddedAgentRunResult = {
  meta: { durationMs: 0, stopReason: "end_turn" },
  payloads: [{ text: "More work remains." }],
};
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
  vi.mocked(enqueueFollowupRun).mockClear();
  vi.mocked(getFollowupQueueDepth).mockReturnValue(0);
  vi.mocked(readSessionEntryReadOnlyInWorker).mockResolvedValue(entry());
});
afterEach(() => {
  testing.resetReplyRunRegistry();
  vi.useRealTimers();
});

describe("Goal continuation eligibility", () => {
  it.each(["paused", "blocked", "complete", "usage_limited", "budget_limited"] as const)(
    "does not resume %s goals",
    (status) => {
      const current = entry();
      current.goal!.status = status;
      expect(isGoalContinuationCurrent(identity, current)).toBe(false);
    },
  );
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
  it("queues hidden individual work without cloning the source turn's lifecycle", async () => {
    const f = fixture();
    f.params.base.turnAdoptionLifecycle = { onAdopted: () => {} };
    expect(await enqueueGoalContinuation(f.params)).toBe(true);
    const queued = vi.mocked(enqueueFollowupRun).mock.calls[0]![1];
    expect(queued.prompt).toContain("Advance");
    expect(queued.goalContinuation).toEqual(identity);
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
  it("does not enqueue over pending input", async () => {
    const f = fixture();
    vi.mocked(getFollowupQueueDepth).mockReturnValue(1);
    expect(await enqueueGoalContinuation(f.params)).toBe(false);
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
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
