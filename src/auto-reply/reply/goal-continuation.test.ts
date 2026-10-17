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

const identity = { sessionId: "goal-session", lifecycleRevision: "revision-2", goalId: "goal-1" };
const normal: EmbeddedAgentRunResult = {
  meta: { durationMs: 0, stopReason: "end_turn" },
  payloads: [{ text: "More work remains." }],
};
type OutcomePatch = Partial<Omit<EmbeddedAgentRunResult, "meta">> & {
  meta?: Partial<EmbeddedAgentRunResult["meta"]>;
};
function entry(
  overrides: Partial<SessionEntry> = {},
  goal: Partial<NonNullable<SessionEntry["goal"]>> = {},
): SessionEntry {
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
      ...goal,
    },
    ...overrides,
  };
}
async function expectNoContinuation(params: Parameters<typeof enqueueGoalContinuation>[0]) {
  expect(await enqueueGoalContinuation(params)).toBe(false);
  expect(enqueueFollowupRun).not.toHaveBeenCalled();
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
  it.each([
    ["active", () => entry(), true],
    ["refreshed", () => entry({}, { updatedAt: 3000 }), true],
    ["missing", () => undefined, false],
    ["cleared", () => entry({ goal: undefined }), false],
    ["replaced session", () => entry({ sessionId: "replacement" }), false],
    ["reset", () => entry({ lifecycleRevision: "revision-3" }), false],
    ["stopped", () => entry({ abortedLastRun: true }), false],
    ["external runtime", () => entry({ agentHarnessId: "codex" }), false],
    ["replaced goal", () => entry({}, { id: "new-goal" }), false],
    ["paused", () => entry({}, { status: "paused" }), false],
    [
      "exhausted",
      () =>
        entry(
          { totalTokens: 50, totalTokensFresh: true, totalTokensVersion: 1 },
          { tokenBudget: 50 },
        ),
      false,
    ],
  ] as const)("checks %s goal eligibility", (kind, makeEntry, eligible) => {
    const current = makeEntry();
    expect(isGoalContinuationCurrent(identity, current)).toBe(eligible);
    if (kind === "exhausted") {
      expect(current?.goal?.status).toBe("active");
    }
  });
  it.each<OutcomePatch>([
    { meta: { aborted: true } },
    { meta: { yielded: true } },
    { meta: { continuationPending: true } },
    { meta: { timeoutPhase: "provider" } },
    { meta: { error: { kind: "hook_block", message: "Blocked" } } },
    { meta: { pendingToolCalls: [{ id: "tool-1", name: "exec", arguments: "{}" }] } },
    { meta: { stopReason: "refusal" } },
    { didSendDeterministicApprovalPrompt: true },
    { payloads: [{ text: "failed", isError: true }] },
  ])("leaves an existing continuation or failure owner in charge: %j", async (patch) => {
    const f = fixture();
    f.params.result = { ...normal, ...patch, meta: { ...normal.meta, ...patch.meta } };
    await expectNoContinuation(f.params);
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
  it("leaves announcing children from earlier turns with their continuation owner", async () => {
    const f = fixture();
    children.mockResolvedValue([{ runId: "earlier-child" }]);
    await expectNoContinuation(f.params);
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
