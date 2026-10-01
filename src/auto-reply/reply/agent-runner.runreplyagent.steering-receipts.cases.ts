import { expect, it, vi, type Mock } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { TemplateContext } from "../templating.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  parkSteerCandidate,
  type FollowupRun,
} from "./queue.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";

type SteeringReceiptFixture = {
  createMinimalRun: (params: {
    opts?: InternalGetReplyOptions;
    isActive?: boolean;
    shouldSteer?: boolean;
    shouldFollowup?: boolean;
    resolvedQueueMode?: string;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    sessionCtx?: Partial<TemplateContext>;
    runOverrides?: Partial<FollowupRun["run"]>;
    bindActiveAuthority?: boolean;
    attachSteerBackend?: boolean;
  }) => { followupRun: FollowupRun; run: () => Promise<unknown> };
  makeSessionEntry: (overrides?: Partial<SessionEntry>) => SessionEntry;
  makeSessionFixture: (overrides?: Partial<SessionEntry>) => Promise<{
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
  }>;
  state: { queueEmbeddedAgentMessageMock: Mock; runEmbeddedAgentMock: Mock };
};

export function registerSteeringReceiptCases({
  createMinimalRun,
  makeSessionEntry,
  makeSessionFixture,
  state,
}: SteeringReceiptFixture): void {
  it.each(["new", "old"] as const)(
    "keeps a rejected steer skipped when drop:%s discards it",
    async (dropPolicy) => {
      const actualQueue = await vi.importActual<typeof import("./queue.js")>("./queue.js");
      vi.mocked(parkSteerCandidate).mockImplementation(actualQueue.parkSteerCandidate);
      const active = createReplyOperation({
        sessionKey: "main",
        sessionId: "session",
        resetTriggered: false,
      });
      active.setPhase("running");
      const replyState: ReplyOperationRunState = {
        admission: { status: "skipped", reason: "active-run" },
      };
      const candidate = createMinimalRun({
        isActive: true,
        shouldSteer: true,
        shouldFollowup: true,
        resolvedQueueMode: "steer",
        sessionCtx: { MessageSid: `rejected-steer-${dropPolicy}` },
        opts: { [REPLY_OPERATION_RUN_STATE]: replyState },
      });
      candidate.followupRun.messageId = `rejected-steer-${dropPolicy}`;
      const retained: FollowupRun = {
        ...candidate.followupRun,
        messageId: `retained-followup-${dropPolicy}`,
      };
      const enqueueRetained = () =>
        actualQueue.enqueueFollowupRun(
          "main",
          retained,
          { mode: "steer", cap: 1, dropPolicy, debounceMs: 0 },
          "message-id",
          undefined,
          false,
        );
      if (dropPolicy === "new") {
        enqueueRetained();
      } else {
        state.queueEmbeddedAgentMessageMock.mockImplementationOnce(() => {
          enqueueRetained();
          return false;
        });
      }
      try {
        await candidate.run();
        expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledOnce();
        expect(replyState.admission).toEqual({ status: "skipped", reason: "queue-cap" });
        expect(getExistingFollowupQueue("main")?.items).toEqual([retained]);
      } finally {
        clearSessionQueues(["main"]);
        active.complete();
      }
    },
  );

  it("queues a waiting steer when its predecessor outlives terminal delivery", async () => {
    const actualQueue = await vi.importActual<typeof import("./queue.js")>("./queue.js");
    vi.mocked(parkSteerCandidate).mockImplementation(actualQueue.parkSteerCandidate);
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      status: "running",
      restartRecoveryDeliveryRunId: "active-recovery",
      restartRecoveryDeliverySourceRunId: "active-source",
    });
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    const firstEntered = createDeferred();
    const firstAcceptance = createDeferred<boolean>();
    const secondParked = createDeferred();
    state.queueEmbeddedAgentMessageMock.mockReturnValue(true);
    state.queueEmbeddedAgentMessageMock.mockImplementationOnce(() => {
      firstEntered.resolve();
      return firstAcceptance.promise;
    });
    const common = {
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
      sessionEntry,
      sessionStore,
      storePath,
    };
    const first = createMinimalRun({
      ...common,
      sessionCtx: { MessageSid: "first-parked-input" },
    });
    first.followupRun.messageId = "first-parked-input";
    const secondState: ReplyOperationRunState = {
      admission: { status: "skipped", reason: "active-run" },
    };
    const second = createMinimalRun({
      ...common,
      bindActiveAuthority: false,
      attachSteerBackend: false,
      sessionCtx: { MessageSid: "second-parked-input" },
      opts: {
        [REPLY_OPERATION_RUN_STATE]: secondState,
        turnAdoptionLifecycle: {
          onDeferred: () => secondParked.resolve(),
          onAdopted: async () => {},
        },
      },
    });
    second.followupRun.messageId = "second-parked-input";
    second.followupRun.prompt = "answer the second input";
    const firstRun = first.run();
    let secondRun: Promise<unknown> | undefined;
    try {
      await withTestTimeout(firstEntered.promise, 5_000, "first steer never reached its backend");
      secondRun = second.run();
      await withTestTimeout(secondParked.promise, 5_000, "second steer was not parked");
      await replaceSessionEntry(
        { storePath, sessionKey: "main" },
        {
          ...sessionEntry,
          restartRecoveryDeliveryReceiptState: "delivered-terminal",
          restartRecoveryDeliveryToolCallId: "terminal-message-call",
        },
      );

      firstAcceptance.resolve(true);
      await Promise.all([firstRun, secondRun]);

      expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledOnce();
      expect(secondState.admission).toEqual({ status: "accepted", mode: "followup" });
      expect(getExistingFollowupQueue("main")?.items).toEqual([
        expect.objectContaining({
          messageId: "second-parked-input",
          prompt: "answer the second input",
        }),
      ]);
    } finally {
      firstAcceptance.resolve(true);
      await Promise.allSettled([firstRun, ...(secondRun ? [secondRun] : [])]);
      clearSessionQueues(["main"]);
      active.complete();
    }
  });

  for (const receiptState of ["terminal-pending", "delivered-terminal"] as const) {
    it(`queues instead of steering while the active turn holds a ${receiptState} source-reply receipt`, async () => {
      const sessionEntry = makeSessionEntry({
        status: "running",
        restartRecoveryDeliveryRunId: "recovery-run-1",
        restartRecoveryDeliverySourceRunId: "source-turn-1",
        restartRecoveryDeliveryReceiptState: receiptState,
        restartRecoveryDeliveryToolCallId: "message-call-1",
      });
      const sessionStore = { main: sessionEntry };
      const active = createReplyOperation({
        sessionKey: "main",
        sessionId: "session",
        resetTriggered: false,
      });
      active.setPhase("running");
      // The active turn's backend would accept the steer; the failure mode is
      // that the steered message-tool final then gets fail-closed and lost.
      state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
      const runState: ReplyOperationRunState = {};
      const { run } = createMinimalRun({
        opts: { [REPLY_OPERATION_RUN_STATE]: runState },
        isActive: true,
        shouldSteer: true,
        shouldFollowup: true,
        resolvedQueueMode: "steer",
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        sessionCtx: {
          Provider: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "123",
          MessageSid: "steer-terminal-receipt",
        },
        runOverrides: { agentId: "main", messageProvider: "telegram" },
      });

      await expect(run()).resolves.toBeUndefined();

      // A terminal source-reply receipt fail-closes any second terminal send
      // on the same source turn. Steering the new inbound into that turn would
      // reuse the same delivery claim and silently lose its reply (#128971).
      expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(runState.admission).toEqual({ status: "accepted", mode: "followup" });
      expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
      active.complete();
    });
  }

  it("queues instead of steering while the active turn holds a terminal-source tombstone", async () => {
    // The claim was cleaned after the terminal send; the source turn stays
    // tombstoned so a steered send resolves to already-delivered (#128971).
    const sessionEntry = makeSessionEntry({
      status: "running",
      restartRecoveryTerminalRunIds: ["source-turn-1"],
    });
    const sessionStore = { main: sessionEntry };
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    // The owning registry records the active source turn when the run admits
    // its delivery claim; this tombstone belongs to that exact source.
    replyRunRegistry.bindSourceTurnId(active, "source-turn-1");
    active.setPhase("running");
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const runState: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
        MessageSid: "steer-terminal-tombstone",
      },
      runOverrides: { agentId: "main", messageProvider: "telegram" },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runState.admission).toEqual({ status: "accepted", mode: "followup" });
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    active.complete();
  });

  it("steers while the retained terminal-source tombstone belongs to an unrelated prior source turn", async () => {
    // Terminal run ids are accumulated session history. A tombstone left by a
    // finished earlier source must not fence a safe steer into the active run:
    // only the active source turn's own tombstone fail-closes delivery.
    const sessionEntry = makeSessionEntry({
      status: "running",
      restartRecoveryTerminalRunIds: ["source-turn-1"],
    });
    const sessionStore = { main: sessionEntry };
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    // The active run owns a different source turn ("source-turn-2"); the
    // retained tombstone belongs to an unrelated earlier turn.
    replyRunRegistry.bindSourceTurnId(active, "source-turn-2");
    active.setPhase("running");
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const runState: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
        MessageSid: "steer-unrelated-tombstone",
      },
      runOverrides: { agentId: "main", messageProvider: "telegram" },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    active.complete();
  });

  it("queues instead of steering while the active turn holds an unresolved terminal tool-call id", async () => {
    // beginTerminalSourceReplyDelivery fail-closes any send while a terminal
    // tool-call id is armed, even without a receipt state (delivery-ambiguous).
    const sessionEntry = makeSessionEntry({
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-run-1",
      restartRecoveryDeliverySourceRunId: "source-turn-1",
      restartRecoveryDeliveryToolCallId: "message-call-2",
    });
    const sessionStore = { main: sessionEntry };
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const runState: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
        MessageSid: "steer-terminal-toolcall",
      },
      runOverrides: { agentId: "main", messageProvider: "telegram" },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runState.admission).toEqual({ status: "accepted", mode: "followup" });
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    active.complete();
  });

  it("queues instead of steering while the active turn holds a stale delivery claim", async () => {
    // A non-running session entry keeps its claim fields but the owner is no
    // longer "running", so beginTerminalSourceReplyDelivery resolves to stale.
    const sessionEntry = makeSessionEntry({
      status: "done",
      restartRecoveryDeliveryRunId: "recovery-run-1",
      restartRecoveryDeliverySourceRunId: "source-turn-1",
    });
    const sessionStore = { main: sessionEntry };
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const runState: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
        MessageSid: "steer-terminal-stale",
      },
      runOverrides: { agentId: "main", messageProvider: "telegram" },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runState.admission).toEqual({ status: "accepted", mode: "followup" });
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    active.complete();
  });

  it("does not replay an accepted steer after terminal delivery", async () => {
    // Accepted input is already owned by its injection target. A later receipt cannot authorize replay.
    const sessionEntry = makeSessionEntry({
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-run-1",
      restartRecoveryDeliverySourceRunId: "source-turn-1",
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
    });
    const sessionStore = { main: sessionEntry };
    const runState: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      opts: {
        messageInjectionDisposition: "accepted",
        [REPLY_OPERATION_RUN_STATE]: runState,
      },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
        MessageSid: "steer-accepted-terminal",
      },
      runOverrides: { agentId: "main", messageProvider: "telegram" },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(runState.admission).toEqual({ status: "accepted", mode: "steer" });
    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });
}
