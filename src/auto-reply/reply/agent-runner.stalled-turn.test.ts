// Tests how an admitted interactive run continues a turn the stale watchdog dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createSqliteTranscriptTarget,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import type { TemplateContext } from "../templating.js";
import type * as AgentRunnerExecution from "./agent-runner-execution.js";
import { runReplyAgent } from "./agent-runner.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import { expireStaleReplyOperation } from "./reply-run-registry.state.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { createMockTypingController } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
  executeAgentTurn: vi.fn(),
  preflight: vi.fn(async (_params: { abortSignal: AbortSignal }) => undefined),
  drainedRuns: vi.fn(async (_run: FollowupRun) => {}),
  executeFollowups: false,
  routeReply: vi.fn(async (..._args: unknown[]) => ({ ok: true, delivered: true })),
  followupSettled: () => {},
}));
const executeAgentTurnMock = mocks.executeAgentTurn;
const drainedRuns = mocks.drainedRuns;
let executionStarted = createDeferred();

vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: (params: { abortSignal: AbortSignal }) => mocks.preflight(params),
  runMemoryFlushIfNeeded: async () => ({ sessionEntry: undefined, outcome: "skipped" }),
}));

vi.mock("./agent-runner-execution.js", async () => ({
  ...(await vi.importActual<typeof AgentRunnerExecution>("./agent-runner-execution.js")),
  executeAgentTurn: (...args: unknown[]) => mocks.executeAgentTurn(...args),
}));

vi.mock("./followup-runner.js", async (importOriginal) => {
  const { createFollowupRunner } = await importOriginal<typeof import("./followup-runner.js")>();
  return {
    createFollowupRunner: (...args: Parameters<typeof createFollowupRunner>) => {
      const runFollowup = createFollowupRunner(...args);
      return async (queued: FollowupRun) => {
        await mocks.drainedRuns(queued);
        if (mocks.executeFollowups) {
          try {
            await runFollowup(queued);
          } finally {
            mocks.followupSettled();
          }
        }
      };
    },
  };
});

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => channel === "telegram",
  routeReply: (...args: unknown[]) => mocks.routeReply(...args),
}));

type StalledRun = {
  operation: ReplyOperation;
  run: Promise<unknown>;
  runState: ReplyOperationRunState;
  recorder: ReturnType<typeof createUserTurnTranscriptRecorder>;
  transcriptTarget: ReturnType<typeof createSqliteTranscriptTarget>;
};

const queueKey = "agent:main:telegram:direct:stalled";
const settings: QueueSettings = { mode: "followup", debounceMs: 0 };

function createStalledRun(
  options: {
    isHeartbeat?: boolean;
    operatorAuthority?: AdmittedRunOperatorAuthority;
    queuedFollowupReplyDisposition?: FollowupRun["queuedFollowupReplyDisposition"];
  } = {},
): StalledRun {
  const followupRun = createTestFollowupRun({
    sessionId: "stalled-session",
    sessionKey: queueKey,
    messageProvider: "telegram",
    senderId: "traveler",
  });
  followupRun.originatingChannel = "telegram";
  followupRun.originatingTo = "12345";
  followupRun.operatorAuthority = options.operatorAuthority;
  followupRun.queuedFollowupReplyDisposition = options.queuedFollowupReplyDisposition;
  followupRun.images = [{ type: "image", data: "aW1n", mimeType: "image/png" }];
  followupRun.transcriptPrompt = "what is good at the hotel restaurant?";
  const transcriptTarget = createSqliteTranscriptTarget({
    dir: followupRun.run.workspaceDir,
    sessionId: "stalled-session",
    sessionKey: queueKey,
  });
  const recorder = createUserTurnTranscriptRecorder({
    input: { text: followupRun.transcriptPrompt },
    target: transcriptTarget,
  });
  followupRun.userTurnTranscriptRecorder = recorder;
  const operation = createReplyOperation({
    sessionKey: queueKey,
    sessionId: "stalled-session",
    resetTriggered: false,
  });
  operation.setPhase("running");
  const runState: ReplyOperationRunState = {};
  const run = runReplyAgent({
    commandBody: "what is good at the hotel restaurant?",
    followupRun,
    queueKey,
    resolvedQueue: settings,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    replyOperation: operation,
    opts: {
      [REPLY_OPERATION_RUN_STATE]: runState,
      ...(options.isHeartbeat ? { isHeartbeat: true } : {}),
    },
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
      ChatType: "direct",
      MessageSid: "msg-stalled",
    } as unknown as TemplateContext,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
  return { operation, run, runState, recorder, transcriptTarget };
}

async function stallBeforeOutput(stalled: StalledRun) {
  await executionStarted.promise;
  expect(executeAgentTurnMock).toHaveBeenCalledOnce();
  expect(expireStaleReplyOperation(stalled.operation, "stuck_recovery")).toBe(false);
}

async function settleStalledOwner(stalled: StalledRun) {
  await stalled.run;
  stalled.operation.complete();
}

function createQueuedRequest(from: { senderId: string; to: string }): FollowupRun {
  const queued = createTestFollowupRun({
    sessionId: "stalled-session",
    sessionKey: queueKey,
    messageProvider: "telegram",
    terminalReplyExpectation: "required",
    senderId: from.senderId,
  });
  queued.originatingChannel = "telegram";
  queued.originatingTo = from.to;
  queued.prompt = "answer already";
  queued.messageId = "msg-followup";
  return queued;
}

describe("runReplyAgent stalled turn continuation", () => {
  beforeEach(() => {
    replyRunTesting.resetReplyRunRegistry();
    clearSessionQueues([queueKey]);
    drainedRuns.mockClear();
    mocks.executeFollowups = false;
    executionStarted = createDeferred();
    mocks.preflight.mockReset().mockResolvedValue(undefined);
    mocks.routeReply.mockClear();
    mocks.followupSettled = () => {};
    executeAgentTurnMock
      .mockReset()
      .mockImplementation(async (params: { replyOperation: { abortSignal: AbortSignal } }) => {
        executionStarted.resolve();
        await new Promise<void>((resolve) => {
          params.replyOperation.abortSignal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return { runId: "stalled-run", outcome: { kind: "aborted", reason: "user" } };
      });
  });

  afterEach(() => {
    clearSessionQueues([queueKey]);
    replyRunTesting.resetReplyRunRegistry();
  });

  it("queues exactly one transcript-only recovery run when nothing else is queued", async () => {
    const stalled = createStalledRun();
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn?.()).toBe(true);
    expect(getFollowupQueueDepth(queueKey)).toBe(1);
    // The lane stays dormant until the stalled owner releases the session.
    expect(drainedRuns).not.toHaveBeenCalled();

    await settleStalledOwner(stalled);
    await vi.waitFor(() => expect(drainedRuns).toHaveBeenCalledOnce());
    const recovery = drainedRuns.mock.calls[0]?.[0];
    expect(recovery?.stalledTurnRecovery).toBe(true);
    expect(recovery?.prompt).toContain("previous turn stopped making progress");
    // Replay safety: the inbound request is not re-sent or re-persisted.
    expect(recovery?.run.suppressNextUserMessagePersistence).toBe(true);
    expect(recovery?.transcriptPrompt).toBeUndefined();
    expect(recovery?.images).toBeUndefined();
    expect(recovery?.abortSignal).toBeUndefined();
    expect(recovery?.run.sessionKey).toBe(queueKey);
    expect(stalled.recorder.hasPersisted()).toBe(true);
    expect(await readTranscriptMessages(stalled.transcriptTarget)).toEqual([
      expect.objectContaining({ content: "what is good at the hotel restaurant?" }),
    ]);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
  });

  it.each(["followup", "collect"] as const)(
    "sends one last-resort notice when the claimed %s request also stalls",
    async (mode) => {
      mocks.executeFollowups = true;
      const settled = createDeferred();
      mocks.followupSettled = settled.resolve;
      const stalled = createStalledRun();
      const queued = createQueuedRequest({ senderId: "traveler", to: "12345" });
      queued.messageId = "msg-double-stall-" + mode;
      expect(
        enqueueFollowupRun(queueKey, queued, { ...settings, mode }, "message-id", undefined, false),
      ).toBe(true);
      await stallBeforeOutput(stalled);
      executeAgentTurnMock.mockImplementationOnce(async ({ replyOperation }) => {
        expireStaleReplyOperation(replyOperation, "stuck_recovery");
        return { runId: "recovery-run", outcome: { kind: "aborted", reason: "user" } };
      });

      expect(stalled.runState.continueStalledTurn?.()).toBe(true);
      expect(queued.currentInboundContext?.fragments).toContainEqual({
        kind: "runtime-instruction",
        text: expect.stringContaining("previous turn stopped making progress"),
      });
      await settleStalledOwner(stalled);
      await settled.promise;
      expect(drainedRuns).toHaveBeenCalledExactlyOnceWith(queued);

      expect(mocks.routeReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          channel: "telegram",
          to: "12345",
          payload: expect.objectContaining({
            text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
            isError: true,
          }),
        }),
      );
      expect(executeAgentTurnMock).toHaveBeenCalledTimes(2);
    },
  );

  // Default DM scope shares one main session across senders.
  it("never hands the stalled request past another sender's earlier queued request", async () => {
    const stalled = createStalledRun();
    const queued = createQueuedRequest({ senderId: "bystander", to: "67890" });
    const sameSenderLater = createQueuedRequest({ senderId: "traveler", to: "12345" });
    sameSenderLater.messageId = "msg-later";
    for (const run of [queued, sameSenderLater]) {
      expect(enqueueFollowupRun(queueKey, run, settings, "message-id", drainedRuns, false)).toBe(
        true,
      );
    }
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn?.()).toBe(true);
    expect(queued.currentInboundContext).toBeUndefined();
    expect(sameSenderLater.currentInboundContext).toBeUndefined();

    await settleStalledOwner(stalled);
    await vi.waitFor(() => expect(drainedRuns).toHaveBeenCalledTimes(3));
    const [recovery, next, last] = drainedRuns.mock.calls.map(([run]) => run);
    expect(recovery).toMatchObject({
      stalledTurnRecovery: true,
      originatingTo: "12345",
      run: { senderId: "traveler" },
    });
    expect(next).toBe(queued);
    expect(last).toBe(sameSenderLater);
  });

  it("leaves dispatch responsible for a stall before the request reaches the transcript", async () => {
    const preflightStarted = createDeferred();
    mocks.preflight.mockImplementationOnce(async ({ abortSignal }) => {
      preflightStarted.resolve();
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      abortSignal.throwIfAborted();
      return undefined;
    });
    const stalled = createStalledRun();
    const settled = stalled.run.catch(() => undefined);
    await preflightStarted.promise;
    expireStaleReplyOperation(stalled.operation, "stuck_recovery");

    const continued = stalled.runState.continueStalledTurn?.();
    await settled;
    stalled.operation.complete();
    expect(stalled.recorder.hasPersisted()).toBe(false);
    expect(continued).toBe(false);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
    expect(executeAgentTurnMock).not.toHaveBeenCalled();
    expect(await readTranscriptMessages(stalled.transcriptTarget)).toEqual([]);
  });

  it("falls back to the notice once the stalled turn's authority is revoked", async () => {
    let revoked = false;
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "operator",
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (revoked) {
          throw new Error("operator authority revoked");
        }
      },
    });
    const stalled = createStalledRun({ operatorAuthority });
    await stallBeforeOutput(stalled);
    revoked = true;

    expect(stalled.runState.continueStalledTurn?.()).toBe(false);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);

    await settleStalledOwner(stalled);
    expect(drainedRuns).not.toHaveBeenCalled();
  });

  it("leaves the notice with a Web UI chat.send turn whose reply owner never queued", async () => {
    // The Gateway's chat.send reply owner delivers only follow-ups it deferred itself.
    const gatewayDeliver = vi.fn(async () => ({ kind: "delivered" as const }));
    const chatSendOwner = createChatSendLateFollowupDisposition({
      runId: "chat-send-run",
      originatingChannel: "webchat",
      logGateway: { info: vi.fn() } as never,
      deliver: gatewayDeliver,
    });
    const stalled = createStalledRun({
      queuedFollowupReplyDisposition: { kind: "deliver", deliver: chatSendOwner.deliver },
    });
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn?.()).toBe(false);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);

    await settleStalledOwner(stalled);
    expect(drainedRuns).not.toHaveBeenCalled();
  });

  it("does not arm a continuation for heartbeat turns", async () => {
    const stalled = createStalledRun({ isHeartbeat: true });
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn).toBeUndefined();

    await settleStalledOwner(stalled);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
  });
});
