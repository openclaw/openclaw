// Tests agent-runner-steer-adoption queue lifecycle ownership transfer.
import { describe, expect, it, vi } from "vitest";
import type { runActiveReplySteer as RunActiveReplySteer } from "./agent-runner-steer-adoption.js";
import type { FollowupRun } from "./queue.js";
import { parkSteerCandidate } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";

type ActiveReplySteerParams = Parameters<typeof RunActiveReplySteer>[0];

const mocks = vi.hoisted(() => ({
  parkedConsume: vi.fn(),
  parkedAdmit: vi.fn(async () => "steer" as const),
  finalizeReplyMessageInjectionAttempt: vi.fn<
    (
      attempt: unknown,
    ) => Promise<{ status: "accepted" | "rejected"; outcome: Record<string, unknown> }>
  >(async () => ({
    status: "accepted",
    outcome: {},
  })),
  queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(async () => ({
    queued: true,
    steerSessionId: "session-1",
  })),
  admitFollowupRunLifecycle: vi.fn(),
  completeFollowupRunLifecycle: vi.fn(),
  refreshReplyOperationTyping: vi.fn(),
  touchActiveSessionEntry: vi.fn(),
  typingCleanup: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  parkSteerCandidate: vi.fn(() => ({
    consume: mocks.parkedConsume,
    admit: mocks.parkedAdmit,
    fallback: vi.fn(),
  })),
  admitFollowupRunLifecycle: mocks.admitFollowupRunLifecycle,
  completeFollowupRunLifecycle: mocks.completeFollowupRunLifecycle,
  resolveFollowupAbortSignal: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  queueEmbeddedAgentMessageWithOutcomeAsync: mocks.queueEmbeddedAgentMessageWithOutcomeAsync,
  formatEmbeddedAgentQueueFailureSummary: vi.fn(),
}));

vi.mock("./reply-run-typing.js", () => ({
  refreshReplyOperationTyping: mocks.refreshReplyOperationTyping,
}));

vi.mock("./agent-runner-core.js", () => ({
  scheduleFollowupDrainAfterReplyOperationClear: vi.fn(),
}));

vi.mock("./reply-run-registry.js", () => ({
  replyRunRegistry: {
    get: vi.fn(),
    resolveCurrentMessageInjectionTarget: vi.fn(() => ({})),
  },
  beginReplyMessageInjectionTarget: vi.fn(() => ({})),
  finalizeReplyMessageInjectionAttempt: mocks.finalizeReplyMessageInjectionAttempt,
  runAfterReplyOperationClear: vi.fn(),
}));

const { runActiveReplySteer } = await import("./agent-runner-steer-adoption.js");

type MakeParamsOverrides = Omit<
  Partial<ActiveReplySteerParams>,
  "providedReplyOperation" | "followupRun"
> & {
  providedReplyOperation?: Partial<ReplyOperation>;
  followupRun?: Partial<FollowupRun>;
};

/** Builds a minimal params object for runActiveReplySteer in tests. */
function makeParams(overrides: MakeParamsOverrides = {}): ActiveReplySteerParams {
  const { providedReplyOperation, followupRun, ...rest } = overrides;
  return {
    queueKey: "queue-1",
    sessionKey: "session-1",
    sessionCtx: {
      Provider: "telegram",
      AccountId: "default",
      MessageSid: "msg-1",
    } as unknown as ActiveReplySteerParams["sessionCtx"],
    replyOperationRunState: {} as unknown as ActiveReplySteerParams["replyOperationRunState"],
    touchActiveSessionEntry: mocks.touchActiveSessionEntry,
    typingSignals: {
      shouldStartImmediately: false,
    } as unknown as ActiveReplySteerParams["typingSignals"],
    typing: { cleanup: mocks.typingCleanup } as unknown as ActiveReplySteerParams["typing"],
    releaseAdmissionTicket: vi.fn(),
    resolvedQueue: { debounceMs: 100 } as unknown as ActiveReplySteerParams["resolvedQueue"],
    opts: undefined,
    restartRecoverySourceTurnId: undefined,
    runFollowup: vi.fn(async () => {}),
    toolAuthorityFingerprint: "test-fingerprint",
    providedReplyOperation: (providedReplyOperation ?? {}) as unknown as ReplyOperation,
    followupRun: (followupRun ?? {
      run: { sessionId: "steer-session" },
    }) as unknown as FollowupRun,
    ...rest,
  };
}

describe("runActiveReplySteer", () => {
  it("transfers cleanup ownership of accepted steer from queued followup to active operation terminal callback", async () => {
    let capturedSettlementResolve: (() => void) | undefined;
    const ownerSettlement = new Promise<void>((resolve) => {
      capturedSettlementResolve = resolve;
    });

    const followupRun: Partial<FollowupRun> = {
      hostWorkspaceStagingDir: "/tmp/steer-staging",
      turnAdoptionLifecycle: {
        onAdopted: vi.fn(),
      } as unknown as FollowupRun["turnAdoptionLifecycle"],
      run: { sessionId: "steer-session" } as unknown as FollowupRun["run"],
    };

    const activeReplyOperation: Partial<ReplyOperation> = {
      ownerSettlement,
      recordActivity: vi.fn(),
      markAcceptedSteeredInboundAudio: vi.fn(),
    };

    const onHostStagingDelegated = vi.fn();
    await runActiveReplySteer(
      makeParams({
        providedReplyOperation: activeReplyOperation,
        followupRun,
        opts: { onHostStagingDelegated } as unknown as ActiveReplySteerParams["opts"],
      }),
    );

    expect(mocks.parkedConsume).toHaveBeenCalled();
    expect(onHostStagingDelegated).toHaveBeenCalled();

    // Staging properties are removed so the lifecycle doesn't double-clean them
    expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
    expect(followupRun.turnAdoptionLifecycle).toBeUndefined();

    // completeFollowupRunLifecycle should NOT have been called yet — it waits for settlement
    expect(mocks.completeFollowupRunLifecycle).not.toHaveBeenCalled();

    // Settling the owner promise triggers the deferred cleanup
    capturedSettlementResolve!();
    await ownerSettlement;
    await Promise.resolve(); // flush microtask queue so .then() callbacks fire

    expect(mocks.completeFollowupRunLifecycle).toHaveBeenCalledWith({
      hostWorkspaceStagingDir: "/tmp/steer-staging",
      turnAdoptionLifecycle: expect.any(Object),
    });
  });

  it("retains staging and delegates fallback when steer is rejected", async () => {
    // Override the injection attempt to reject this steer
    mocks.finalizeReplyMessageInjectionAttempt.mockResolvedValueOnce({
      status: "rejected",
      outcome: { reason: "steer rejected by model" },
    });

    const followupRun: Partial<FollowupRun> = {
      hostWorkspaceStagingDir: "/tmp/steer-staging",
      turnAdoptionLifecycle: {
        onAdopted: vi.fn(),
      } as unknown as FollowupRun["turnAdoptionLifecycle"],
      run: { sessionId: "steer-session" } as unknown as FollowupRun["run"],
    };

    const activeReplyOperation: Partial<ReplyOperation> = {
      ownerSettlement: undefined,
      recordActivity: vi.fn(),
      markAcceptedSteeredInboundAudio: vi.fn(),
    };

    const fallbackMock = vi.fn();
    vi.mocked(parkSteerCandidate).mockReturnValueOnce({
      consume: mocks.parkedConsume,
      admit: mocks.parkedAdmit,
      accepted: vi.fn(),
      fallback: fallbackMock,
    } as unknown as ReturnType<typeof parkSteerCandidate>);

    await runActiveReplySteer(
      makeParams({ providedReplyOperation: activeReplyOperation, followupRun }),
    );

    // The steer was rejected, so fallback path runs
    expect(fallbackMock).toHaveBeenCalled();

    // Staging properties must NOT be cleared on rejection — the fallback path owns cleanup
    expect(followupRun.hostWorkspaceStagingDir).toBe("/tmp/steer-staging");
    expect(followupRun.turnAdoptionLifecycle).toBeDefined();
  });
});
