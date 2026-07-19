import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import {
  handleUpdateProbationInbound,
  isUpdateConfirmationProbationActive,
  maybeConfirmUpdateFromInbound,
  registerPendingHumanUpdateConfirmation,
  registerPendingUpdateConfirmation,
  registerUpdateConfirmationContinuation,
  resetPendingHumanUpdateConfirmationForTest,
  resolveUpdateConfirmationProbation,
  sealUpdateConfirmationReplayAdmissions,
  startUpdateConfirmationOwnerLeaseWatchdog,
} from "./update-confirmation-runtime.js";

const markHumanReply = vi.hoisted(() => vi.fn());
const beginReplayAdmission = vi.hoisted(() => vi.fn());
const completeReplayAdmission = vi.hoisted(() => vi.fn());
const markConfirmationFailed = vi.hoisted(() => vi.fn());
const markProbationReleased = vi.hoisted(() => vi.fn());
const scheduleConfirmedCleanup = vi.hoisted(() => vi.fn());
const enqueueRollbackReplay = vi.hoisted(() =>
  vi.fn<typeof import("./session-delivery-queue.js").enqueueSessionDeliveryInExistingState>(
    async () => "queued-replay",
  ),
);
const enqueueCandidateReplay = vi.hoisted(() =>
  vi.fn<typeof import("./session-delivery-queue.js").enqueueClaimedSessionDelivery>(async () => ({
    id: "candidate-replay",
    claimed: true,
    status: "pending" as const,
  })),
);
const releaseCandidateReplay = vi.hoisted(() =>
  vi.fn<typeof import("./session-delivery-queue.js").releaseSessionDeliveryClaim>(async () => {}),
);
const scheduleCandidateReplay = vi.hoisted(() =>
  vi.fn<typeof import("./session-delivery-queue-runtime.js").scheduleSessionDelivery>(
    async () => true,
  ),
);
const listCandidateReplays = vi.hoisted(() =>
  vi.fn<typeof import("./session-delivery-queue.js").loadPendingSessionDeliveries>(async () => []),
);
const schedulePendingCandidateReplays = vi.hoisted(() =>
  vi.fn<typeof import("./session-delivery-queue-runtime.js").schedulePendingSessionDeliveries>(
    async () => {},
  ),
);

vi.mock("./update-transaction-marker.js", () => ({
  markUpdateTransactionHumanReply: (params: unknown) => markHumanReply(params),
  beginUpdateTransactionReplayAdmission: (params: unknown) => beginReplayAdmission(params),
  completeUpdateTransactionReplayAdmission: (params: unknown) => completeReplayAdmission(params),
  markUpdateTransactionConfirmationFailed: (params: unknown) => markConfirmationFailed(params),
  markUpdateTransactionProbationReleased: (params: unknown) => markProbationReleased(params),
}));

vi.mock("./update-interrupted-recovery.js", () => ({
  scheduleConfirmedUpdateCleanup: (params: unknown) => scheduleConfirmedCleanup(params),
}));

vi.mock("./session-delivery-queue.js", () => ({
  enqueueSessionDeliveryInExistingState: enqueueRollbackReplay,
  enqueueClaimedSessionDelivery: enqueueCandidateReplay,
  loadPendingSessionDeliveries: listCandidateReplays,
  releaseSessionDeliveryClaim: releaseCandidateReplay,
}));

vi.mock("./session-delivery-queue-runtime.js", () => ({
  scheduleSessionDelivery: scheduleCandidateReplay,
  schedulePendingSessionDeliveries: schedulePendingCandidateReplays,
}));

describe("update confirmation inbound gate", () => {
  beforeEach(() => {
    resetPendingHumanUpdateConfirmationForTest();
    markHumanReply.mockReset();
    beginReplayAdmission.mockReset();
    beginReplayAdmission.mockResolvedValue({
      payload: { stats: { confirmationStatus: "pending" } },
    });
    completeReplayAdmission.mockReset();
    completeReplayAdmission.mockResolvedValue({
      payload: { stats: { confirmationStatus: "pending" } },
    });
    markConfirmationFailed.mockReset();
    markConfirmationFailed.mockResolvedValue({
      payload: { stats: { confirmationStatus: "failed" } },
    });
    markProbationReleased.mockReset();
    markProbationReleased.mockResolvedValue({
      payload: { stats: { updateProbationReleasedAtMs: 1 } },
    });
    scheduleConfirmedCleanup.mockReset();
    enqueueRollbackReplay.mockClear();
    enqueueCandidateReplay.mockReset();
    enqueueCandidateReplay.mockImplementation(async () => ({
      id: `candidate-replay-${enqueueCandidateReplay.mock.calls.length}`,
      claimed: true,
      status: "pending" as const,
    }));
    releaseCandidateReplay.mockClear();
    scheduleCandidateReplay.mockClear();
    listCandidateReplays.mockReset();
    listCandidateReplays.mockResolvedValue([]);
    schedulePendingCandidateReplays.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the marker path only for the matching real inbound reply", async () => {
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-1",
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      accountId: "default",
      confirmationChallenge: "challenge-1",
      stateSnapshotRoot: "/retained/state-snapshot",
    });
    const blockedInternal = handleUpdateProbationInbound({
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      accountId: "default",
      internal: true,
      rollbackReplay: {
        messageId: "internal-1",
        ctxPayload: { Body: "internal", ChatType: "direct" } as FinalizedMsgContext,
      },
    });
    await Promise.resolve();
    expect(markHumanReply).not.toHaveBeenCalled();

    markHumanReply.mockResolvedValue({
      payload: { stats: { confirmationStatus: "human-confirmed" } },
    });
    expect(await blockedInternal).toBe("deferred");
    const wrongAccount = handleUpdateProbationInbound({
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      accountId: "other",
      internal: false,
      confirmationText: "confirm challenge-1",
      rollbackReplay: {
        messageId: "wrong-account-1",
        ctxPayload: { Body: "wrong account", ChatType: "direct" } as FinalizedMsgContext,
      },
    });
    expect(await wrongAccount).toBe("deferred");
    expect(markHumanReply).not.toHaveBeenCalled();
    expect(
      await maybeConfirmUpdateFromInbound({
        sessionKey: "session-1",
        channel: "telegram",
        to: "chat-1",
        accountId: "default",
        internal: false,
        confirmationText: "confirm challenge-1",
      }),
    ).toBe(true);
    expect(markHumanReply).toHaveBeenCalledWith({
      handoffId: "handoff-1",
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      accountId: "default",
      confirmationChallenge: "challenge-1",
    });
  });

  it("drains a deferred continuation only after confirmation", async () => {
    const run = vi.fn(async () => {});
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-continuation",
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      confirmationChallenge: "challenge-retry",
      stateSnapshotRoot: "/retained/state-snapshot",
    });
    registerUpdateConfirmationContinuation({ handoffId: "handoff-continuation", run });

    expect(run).not.toHaveBeenCalled();
    await resolveUpdateConfirmationProbation("handoff-continuation", "confirmed");
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(scheduleConfirmedCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ handoffId: "handoff-continuation" }),
    );
  });

  it("keeps probation active until replay release is durably recorded", async () => {
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-release-retry",
      sessionKey: "session-1",
      channel: "telegram",
    });
    markProbationReleased.mockRejectedValueOnce(new Error("state locked"));

    await expect(
      resolveUpdateConfirmationProbation("handoff-release-retry", "confirmed"),
    ).rejects.toThrow("state locked");
    expect(isUpdateConfirmationProbationActive()).toBe(true);

    await resolveUpdateConfirmationProbation("handoff-release-retry", "confirmed");
    expect(isUpdateConfirmationProbationActive()).toBe(false);
  });

  it("keeps replay admission sealed while resuming durable confirmation", async () => {
    registerPendingUpdateConfirmation(
      {
        handoffId: "handoff-resumed-confirmation",
        sessionKey: "session-1",
        channel: "telegram",
        tier: "delivery",
        stateSnapshotRoot: "/retained/state-snapshot",
      },
      { replayAdmissionsSealed: true },
    );

    const inbound = handleUpdateProbationInbound({
      sessionKey: "session-2",
      channel: "telegram",
      to: "chat-2",
      internal: false,
      rollbackReplay: {
        messageId: "message-after-confirmation",
        ctxPayload: { Body: "wait for release", ChatType: "direct" } as FinalizedMsgContext,
      },
    });
    await Promise.resolve();
    expect(beginReplayAdmission).not.toHaveBeenCalled();

    await resolveUpdateConfirmationProbation("handoff-resumed-confirmation", "confirmed");
    await expect(inbound).resolves.toBe("continue");
    expect(enqueueRollbackReplay).not.toHaveBeenCalled();
  });

  it("durably defers unrelated callbacks without blocking the channel adapter", async () => {
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-held",
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      confirmationChallenge: "challenge-retry",
      stateSnapshotRoot: "/retained/state-snapshot",
    });
    const deferred = handleUpdateProbationInbound({
      sessionKey: "session-2",
      channel: "telegram",
      to: "chat-2",
      internal: false,
      rollbackReplay: {
        messageId: "message-held",
        ctxPayload: { Body: "defer me", ChatType: "direct" } as FinalizedMsgContext,
      },
    });
    await expect(deferred).resolves.toBe("deferred");
    expect(enqueueRollbackReplay).toHaveBeenCalledOnce();
    expect(enqueueCandidateReplay).toHaveBeenCalledOnce();
    expect(scheduleCandidateReplay).toHaveBeenCalledWith("candidate-replay-1");

    await resolveUpdateConfirmationProbation("handoff-held", "confirmed");
    await vi.waitFor(() =>
      expect(releaseCandidateReplay).toHaveBeenCalledWith("candidate-replay-1"),
    );
  });

  it("keeps deferred replay in the snapshot when probation rolls back", async () => {
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-cancelled",
      sessionKey: "session-1",
      channel: "telegram",
      stateSnapshotRoot: "/retained/state-snapshot",
    });
    const deferred = handleUpdateProbationInbound({
      sessionKey: "session-2",
      channel: "telegram",
      to: "chat-2",
      internal: true,
      rollbackReplay: {
        messageId: "message-2",
        ctxPayload: {
          BodyForAgent: "message during probation",
          MediaPaths: ["/tmp/image.png"],
          MediaTypes: ["image/png"],
          ChatType: "direct",
        } as FinalizedMsgContext,
      },
    });
    await vi.waitFor(() =>
      expect(enqueueRollbackReplay).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "agentTurn",
          sessionKey: "session-2",
          message: expect.stringContaining("message during probation"),
          messageId: "message-2",
          route: expect.objectContaining({ channel: "telegram", to: "chat-2" }),
        }),
        "/retained/state-snapshot/state",
      ),
    );
    await expect(deferred).resolves.toBe("deferred");
    await resolveUpdateConfirmationProbation("handoff-cancelled", "cancelled");
    await Promise.resolve();
    expect(releaseCandidateReplay).not.toHaveBeenCalled();
  });

  it("requests rollback and leaves the callback unacknowledged when replay persistence fails", async () => {
    enqueueRollbackReplay.mockRejectedValueOnce(new Error("snapshot unavailable"));
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-persist-failed",
      sessionKey: "session-1",
      channel: "telegram",
      stateSnapshotRoot: "/retained/state-snapshot",
    });
    const deferred = handleUpdateProbationInbound({
      sessionKey: "session-2",
      channel: "telegram",
      to: "chat-2",
      internal: false,
      rollbackReplay: {
        messageId: "message-failed",
        ctxPayload: { Body: "hold me", ChatType: "direct" } as FinalizedMsgContext,
      },
    });
    let settled = false;
    void deferred.finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(markConfirmationFailed).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(enqueueRollbackReplay).toHaveBeenCalledOnce();
    expect(enqueueCandidateReplay).not.toHaveBeenCalled();
  });

  it("rolls back without queueing an observe-only callback as a dispatching turn", async () => {
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-observe-only",
      sessionKey: "session-1",
      channel: "telegram",
      stateSnapshotRoot: "/retained/state-snapshot",
    });
    const deferred = handleUpdateProbationInbound({
      sessionKey: "session-observer",
      channel: "telegram",
      to: "broadcast-room",
      internal: false,
      confirmationEligible: false,
      rollbackReplay: {
        admission: "observeOnly",
        messageId: "message-observer",
        ctxPayload: { Body: "observe me", ChatType: "group" } as FinalizedMsgContext,
      },
    });
    let settled = false;
    void deferred.finally(() => {
      settled = true;
    });

    await vi.waitFor(() =>
      expect(markConfirmationFailed).toHaveBeenCalledWith({
        handoffId: "handoff-observe-only",
        reason: "update callback replay cannot preserve observe-only admission",
      }),
    );
    expect(beginReplayAdmission).toHaveBeenCalledWith({
      handoffId: "handoff-observe-only",
    });
    expect(beginReplayAdmission.mock.invocationCallOrder[0]).toBeLessThan(
      markConfirmationFailed.mock.invocationCallOrder[0]!,
    );
    expect(settled).toBe(false);
    expect(enqueueRollbackReplay).not.toHaveBeenCalled();
    expect(enqueueCandidateReplay).not.toHaveBeenCalled();
  });

  it("seals confirmation behind every in-flight dual replay write", async () => {
    let releaseCandidate: (() => void) | undefined;
    enqueueCandidateReplay.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCandidate = () =>
            resolve({ id: "candidate-racing", claimed: true, status: "pending" as const });
        }),
    );
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-racing",
      sessionKey: "session-1",
      channel: "telegram",
      stateSnapshotRoot: "/retained/state-snapshot",
    });
    const deferred = handleUpdateProbationInbound({
      sessionKey: "session-2",
      channel: "telegram",
      to: "chat-2",
      internal: false,
      rollbackReplay: {
        messageId: "message-racing",
        ctxPayload: { Body: "race me", ChatType: "direct" } as FinalizedMsgContext,
      },
    });
    await vi.waitFor(() => expect(enqueueRollbackReplay).toHaveBeenCalledOnce());
    const sealed = sealUpdateConfirmationReplayAdmissions("handoff-racing");
    let sealSettled = false;
    void sealed.finally(() => {
      sealSettled = true;
    });
    await Promise.resolve();
    expect(sealSettled).toBe(false);

    releaseCandidate?.();
    await expect(deferred).resolves.toBe("deferred");
    await expect(sealed).resolves.toBe(true);
    expect(completeReplayAdmission).toHaveBeenCalledOnce();
  });

  it("discovers and releases deferred replay after a probationary restart", async () => {
    listCandidateReplays.mockResolvedValue([
      {
        id: "candidate-after-restart",
        kind: "agentTurn",
        sessionKey: "session-2",
        message: "replay me",
        messageId: "message-after-restart",
        idempotencyKey:
          "update-probation-inbound:handoff-after-restart:session-2:message-after-restart",
        enqueuedAt: 1,
        retryCount: 0,
      },
      {
        id: "continuation-after-restart",
        kind: "systemEvent",
        sessionKey: "session-1",
        text: "post-update continuation",
        idempotencyKey: "update-transaction-continuation:handoff-after-restart:systemEvent",
        enqueuedAt: 1,
        retryCount: 0,
      },
    ]);
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-after-restart",
      sessionKey: "session-1",
      channel: "telegram",
      stateSnapshotRoot: "/retained/state-snapshot",
    });

    await resolveUpdateConfirmationProbation("handoff-after-restart", "confirmed");

    expect(releaseCandidateReplay).toHaveBeenCalledWith("candidate-after-restart");
    expect(releaseCandidateReplay).toHaveBeenCalledWith("continuation-after-restart");
    expect(schedulePendingCandidateReplays).toHaveBeenCalledOnce();
  });

  it("queues destination-less replay without borrowing the initiating chat", async () => {
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-route-missing",
      sessionKey: "session-1",
      channel: "telegram",
      to: "initiating-chat",
      stateSnapshotRoot: "/retained/state-snapshot",
    });
    const deferred = handleUpdateProbationInbound({
      sessionKey: "session-unrouted",
      channel: "telegram",
      internal: false,
      rollbackReplay: {
        messageId: "message-unrouted",
        ctxPayload: { Body: "private message", ChatType: "direct" } as FinalizedMsgContext,
      },
    });

    await expect(deferred).resolves.toBe("deferred");
    expect(enqueueRollbackReplay).toHaveBeenCalledWith(
      expect.not.objectContaining({ route: expect.anything() }),
      "/retained/state-snapshot/state",
    );
    expect(enqueueCandidateReplay).toHaveBeenCalledOnce();
  });

  it("retries human confirmation persistence without admitting the reply", async () => {
    vi.useFakeTimers();
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-retry",
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      confirmationChallenge: "challenge-retry",
    });
    markHumanReply
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ payload: { stats: { confirmationStatus: "human-confirmed" } } });

    const confirmation = maybeConfirmUpdateFromInbound({
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      internal: false,
      confirmationText: "confirm challenge-retry",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(markHumanReply).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(confirmation).resolves.toBe(true);
    expect(markHumanReply).toHaveBeenCalledTimes(2);
  });

  it("claims an abandoned orchestrator and cancels probation", async () => {
    vi.useFakeTimers();
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-lease",
      sessionKey: "session-1",
      channel: "telegram",
    });
    const onExpired = vi.fn();
    const claimExpired = vi.fn(async () => true);
    startUpdateConfirmationOwnerLeaseWatchdog({
      handoffId: "handoff-lease",
      pollMs: 10,
      claimExpired,
      onExpired,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(claimExpired).toHaveBeenCalledWith("handoff-lease", expect.any(String));
    expect(onExpired).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keeps abandoned-owner recovery armed after probation cancellation", async () => {
    vi.useFakeTimers();
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-cancelled-lease",
      sessionKey: "session-1",
      channel: "telegram",
    });
    const claimExpired = vi.fn(async () => false);
    startUpdateConfirmationOwnerLeaseWatchdog({
      handoffId: "handoff-cancelled-lease",
      pollMs: 10,
      claimExpired,
      onExpired: vi.fn(),
    });

    await resolveUpdateConfirmationProbation("handoff-cancelled-lease", "cancelled");
    await vi.advanceTimersByTimeAsync(10);

    expect(claimExpired).toHaveBeenCalledWith("handoff-cancelled-lease", expect.any(String));
  });

  it("does not accept a reply without the fresh confirmation challenge", async () => {
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-race",
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      confirmationChallenge: "fresh-challenge",
      stateSnapshotRoot: "/retained/state-snapshot",
    });

    const deferred = handleUpdateProbationInbound({
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      internal: false,
      confirmationText: "an older queued reply",
      rollbackReplay: {
        messageId: "older-reply",
        ctxPayload: { Body: "an older queued reply", ChatType: "direct" } as FinalizedMsgContext,
      },
    });
    await expect(deferred).resolves.toBe("deferred");
    expect(markHumanReply).not.toHaveBeenCalled();
    await resolveUpdateConfirmationProbation("handoff-race", "cancelled");
    await Promise.resolve();
    expect(markHumanReply).not.toHaveBeenCalled();
  });

  it("requires the initiating thread for human confirmation", async () => {
    registerPendingHumanUpdateConfirmation({
      handoffId: "handoff-thread",
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      threadId: "topic-1",
      confirmationChallenge: "thread-challenge",
      stateSnapshotRoot: "/retained/state-snapshot",
    });
    markHumanReply.mockResolvedValue({
      payload: { stats: { confirmationStatus: "human-confirmed" } },
    });

    const wrongThread = handleUpdateProbationInbound({
      sessionKey: "session-1",
      channel: "telegram",
      to: "chat-1",
      threadId: "topic-2",
      internal: false,
      confirmationText: "confirm thread-challenge",
      rollbackReplay: {
        messageId: "wrong-thread",
        ctxPayload: { Body: "confirm thread-challenge", ChatType: "direct" } as FinalizedMsgContext,
      },
    });
    expect(markHumanReply).not.toHaveBeenCalled();

    await expect(
      maybeConfirmUpdateFromInbound({
        sessionKey: "session-1",
        channel: "telegram",
        to: "chat-1",
        threadId: "topic-1",
        internal: false,
        confirmationText: "confirm thread-challenge",
      }),
    ).resolves.toBe(true);
    await expect(wrongThread).resolves.toBe("deferred");
    expect(markHumanReply).toHaveBeenCalledWith(expect.objectContaining({ threadId: "topic-1" }));
  });
});
