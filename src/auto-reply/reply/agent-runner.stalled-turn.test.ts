// Tests how an admitted interactive run continues a turn the stale watchdog dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import { createChatSendLateReplyFinalizer } from "../../gateway/server-methods/chat-send-source-finalization.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import { resetSessionControllerStateForTest } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createSqliteTranscriptTarget,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { WorkerNodeLostError } from "../../worker/worker-node-loss.js";
import type { TemplateContext } from "../templating.js";
import type * as AgentRunnerExecution from "./agent-runner-execution.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import {
  enqueueFollowupRun,
  getFollowupQueueDepth,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { createMockTypingController } from "./test-helpers.js";

afterEach(() => clearRuntimeConfigSnapshot());

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

// mock-isolation: Stalled-turn cases replace the complete compaction and memory-flush boundary.
vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: (params: { abortSignal: AbortSignal }) => mocks.preflight(params),
  runMemoryFlushIfNeeded: async () => ({ sessionEntry: undefined, outcome: "skipped" }),
}));

vi.mock("./agent-runner-execution.js", async () => ({
  ...(await vi.importActual<typeof AgentRunnerExecution>("./agent-runner-execution.js")),
  executeAgentTurn: (...args: unknown[]) => mocks.executeAgentTurn(...args),
}));

// mock-isolation: Stalled-turn cases wrap the follow-up runner's sole exported entry point.
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

async function createStalledRun(
  options: {
    isHeartbeat?: boolean;
    operatorAuthority?: AdmittedRunOperatorAuthority;
    queuedFollowupReplyDisposition?: FollowupRun["queuedFollowupReplyDisposition"];
    originatingChannel?: string;
    skillLibraryAuthoring?: FollowupRun["run"]["skillLibraryAuthoring"];
  } = {},
): Promise<StalledRun> {
  const followupRun = createTestFollowupRun({
    sessionId: "stalled-session",
    sessionKey: queueKey,
    messageProvider: "telegram",
    senderId: "traveler",
  });
  followupRun.originatingChannel = options.originatingChannel ?? "telegram";
  followupRun.originatingTo = options.originatingChannel ? undefined : "12345";
  followupRun.operatorAuthority = options.operatorAuthority;
  followupRun.queuedFollowupReplyDisposition = options.queuedFollowupReplyDisposition;
  followupRun.run.skillLibraryAuthoring = options.skillLibraryAuthoring;
  followupRun.images = [{ type: "image", data: "aW1n", mimeType: "image/png" }];
  followupRun.transcriptPrompt = "what is good at the hotel restaurant?";
  const transcriptTarget = createSqliteTranscriptTarget({
    dir: followupRun.run.workspaceDir,
    sessionId: "stalled-session",
    sessionKey: queueKey,
  });
  const sessionEntry = { sessionId: transcriptTarget.sessionId, updatedAt: 1 };
  followupRun.run.config = { session: { store: transcriptTarget.storePath } };
  setRuntimeConfigSnapshot(followupRun.run.config);
  await replaceSessionEntry(transcriptTarget, sessionEntry);
  const recorder = createUserTurnTranscriptRecorder({
    input: { text: followupRun.transcriptPrompt },
    target: transcriptTarget,
  });
  followupRun.userTurnTranscriptRecorder = recorder;
  const admitted = await admitReplyTurn({
    ...transcriptTarget,
    kind: options.isHeartbeat ? "heartbeat" : "visible",
    resetTriggered: false,
  });
  if (admitted.status !== "owned") {
    throw new Error("The stalled-turn fixture could not admit its session");
  }
  const operation = admitted.operation;
  operation.setPhase("running");
  const runState: ReplyOperationRunState = {};
  const run = runReplyAgent({
    commandBody: "what is good at the hotel restaurant?",
    followupRun,
    queueKey,
    sessionKey: queueKey,
    storePath: transcriptTarget.storePath,
    sessionEntry,
    sessionStore: { [queueKey]: sessionEntry },
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
  await awaitGateBeforeSettlement(
    executionStarted.promise,
    stalled.run,
    "The admitted turn settled before execution",
  );
  expect(executeAgentTurnMock).toHaveBeenCalledOnce();
  expect(stalled.operation.abortForStall()).toBe(true);
}

async function settleStalledOwner(stalled: StalledRun) {
  await stalled.run;
  stalled.operation.complete();
  await stalled.operation.ownerSettlement;
}

function createQueuedRequest(
  stalled: StalledRun,
  from: { senderId: string; to: string },
): FollowupRun {
  const queued = createTestFollowupRun({
    sessionId: "stalled-session",
    sessionKey: queueKey,
    messageProvider: "telegram",
    terminalReplyExpectation: "required",
    senderId: from.senderId,
    config: { session: { store: stalled.transcriptTarget.storePath } },
  });
  queued.originatingChannel = "telegram";
  queued.originatingTo = from.to;
  queued.prompt = "answer already";
  queued.messageId = "msg-followup";
  return queued;
}

describe("runReplyAgent stalled turn continuation", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    clearSessionQueues([queueKey]);
    resetSessionControllerStateForTest();
    drainedRuns.mockReset();
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

  afterEach(async () => {
    clearSessionQueues([queueKey]);
    resetSessionControllerStateForTest();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  });

  it("queues exactly one transcript-only recovery run when nothing else is queued", async () => {
    const stalled = await createStalledRun();
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
      const stalled = await createStalledRun();
      const queued = createQueuedRequest(stalled, { senderId: "traveler", to: "12345" });
      queued.messageId = "msg-double-stall-" + mode;
      expect(
        enqueueFollowupRun(queueKey, queued, { ...settings, mode }, "message-id", undefined, false),
      ).toBe(true);
      await stallBeforeOutput(stalled);
      executeAgentTurnMock.mockImplementationOnce(async ({ replyOperation }) => {
        replyOperation.abortForStall();
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
    const stalled = await createStalledRun();
    const queued = createQueuedRequest(stalled, { senderId: "bystander", to: "67890" });
    const sameSenderLater = createQueuedRequest(stalled, { senderId: "traveler", to: "12345" });
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
    expect(next).toBe(queued);
    expect(last).toBe(sameSenderLater);
  });

  it("queues node-loss recovery once ahead of newer input without absorbing that input", async () => {
    const drained = createDeferred();
    drainedRuns.mockImplementation(async () => {
      if (drainedRuns.mock.calls.length === 2) {
        drained.resolve();
      }
    });
    const interrupted = await createStalledRun();
    const queued = createQueuedRequest(interrupted, { senderId: "traveler", to: "12345" });
    expect(enqueueFollowupRun(queueKey, queued, settings, "message-id", drainedRuns, false)).toBe(
      true,
    );
    await awaitGateBeforeSettlement(
      executionStarted.promise,
      interrupted.run,
      "The admitted turn settled before execution",
    );
    const guidance = `${new WorkerNodeLostError().message} Continue the interrupted request from the transcript.`;
    const otherIngress = createReplyOperation({
      sessionId: "other-ingress",
      sessionKey: "agent:main:telegram:direct:other",
      resetTriggered: false,
    });
    try {
      expect(interrupted.runState.continueStalledTurn?.(guidance, otherIngress)).toBe(false);
      expect(getFollowupQueueDepth(queueKey)).toBe(1);
    } finally {
      otherIngress.complete();
    }
    expect(interrupted.runState.continueStalledTurn?.(guidance)).toBe(true);
    expect(interrupted.runState.continueStalledTurn?.(guidance)).toBe(false);
    expect(queued.currentInboundContext).toBeUndefined();
    expect(queued.stalledTurnRecovery).toBeUndefined();

    expect(interrupted.operation.abortForStall()).toBe(true);
    await settleStalledOwner(interrupted);
    await drained.promise;
    const [recovery, newer] = drainedRuns.mock.calls.map(([run]) => run);
    expect(recovery).toMatchObject({ stalledTurnRecovery: true, transcriptPrompt: undefined });
    expect(recovery?.prompt).toContain(guidance);
    expect(newer).toBe(queued);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
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
    const stalled = await createStalledRun();
    const settled = stalled.run.catch(() => undefined);
    await awaitGateBeforeSettlement(
      preflightStarted.promise,
      stalled.run,
      "The admitted turn settled before preflight",
    );
    stalled.operation.abortForStall();

    const continued = stalled.runState.continueStalledTurn?.();
    await settled;
    stalled.operation.complete();
    await stalled.operation.ownerSettlement;
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
    const stalled = await createStalledRun({ operatorAuthority });
    await stallBeforeOutput(stalled);
    revoked = true;

    expect(stalled.runState.continueStalledTurn?.()).toBe(false);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);

    await settleStalledOwner(stalled);
    expect(drainedRuns).not.toHaveBeenCalled();
  });

  it("sends the Web UI notice, not a second recovery, when the recovery also stalls", async () => {
    mocks.executeFollowups = true;
    const settled = createDeferred();
    mocks.followupSettled = settled.resolve;
    const context = createGatewayRequestContext(makeContextParams());
    const chatSendOwner = createChatSendLateFollowupDisposition({
      runId: "chat-send-run",
      originatingChannel: "webchat",
      logGateway: context.logGateway,
      deliver: createChatSendLateReplyFinalizer({
        terminalEntry: undefined,
        accountId: undefined,
        context,
        session: {
          agentId: "main",
          backingSessionId: "stalled-session",
          cfg: {},
          clientRunId: "chat-send-run",
          sessionKey: queueKey,
          sessionLoadOptions: { agentId: "main" },
        },
      }),
    });
    const stalled = await createStalledRun({
      originatingChannel: "webchat",
      queuedFollowupReplyDisposition: { kind: "deliver", deliver: chatSendOwner.deliver },
    });
    await stallBeforeOutput(stalled);
    executeAgentTurnMock.mockImplementationOnce(async ({ replyOperation }) => {
      replyOperation.abortForStall();
      return { runId: "recovery-run", outcome: { kind: "aborted", reason: "user" } };
    });

    expect(stalled.runState.continueStalledTurn?.()).toBe(true);
    await settleStalledOwner(stalled);
    await settled.promise;

    expect(drainedRuns).toHaveBeenCalledOnce();
    expect(executeAgentTurnMock).toHaveBeenCalledTimes(2);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
    const chatEvents = vi
      .mocked(context.broadcast)
      .mock.calls.filter(([event]) => event === "chat")
      .map(([, payload]) => payload);
    expect(chatEvents).toEqual([
      expect.objectContaining({
        state: "error",
        errorMessage:
          "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
      }),
    ]);
  });

  it("never lets a workspace-target recovery author skills while keeping its other tools", async () => {
    const stalled = await createStalledRun({
      skillLibraryAuthoring: {
        target: "personal",
        defaultTarget: "workspace",
        multipleProfiles: true,
        bind: () => {
          throw new Error("Personal authoring cannot move to a replacement run.");
        },
        invoke: vi.fn(),
      },
    });
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn?.()).toBe(true);
    await settleStalledOwner(stalled);
    await vi.waitFor(() => expect(drainedRuns).toHaveBeenCalledOnce());
    const recovery = drainedRuns.mock.calls[0]?.[0];
    expect(recovery?.disableTools).toBeUndefined();
    const authoring = recovery?.run.skillLibraryAuthoring;
    // Personal-only means the Workshop cannot fall back to the workspace tool.
    expect(authoring?.defaultTarget).toBe("personal");
    expect(() => authoring?.bind({} as never)).not.toThrow();
    await expect(authoring?.invoke({ action: "list" })).rejects.toMatchObject({
      code: "AUTHORITY_EXPIRED",
    });
  });

  it("leaves the notice with a group-thread participant whose source declares no reply owner", async () => {
    const stalled = await createStalledRun({
      queuedFollowupReplyDisposition: { kind: "drop", reason: "source-unavailable" },
    });
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn?.()).toBe(false);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
    await settleStalledOwner(stalled);
    expect(drainedRuns).not.toHaveBeenCalled();
  });

  it("does not arm a continuation for heartbeat turns", async () => {
    const stalled = await createStalledRun({ isHeartbeat: true });
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn).toBeUndefined();

    await settleStalledOwner(stalled);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
  });
});
