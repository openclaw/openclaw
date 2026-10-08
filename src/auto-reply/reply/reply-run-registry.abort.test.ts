import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
  isAgentRunDirectAbortReason,
} from "../../agents/run-termination.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import type { ReplyBackendHandle } from "./reply-run-registry.contracts.js";
import {
  abortActiveReplyRuns,
  beginReplyMessageInjectionTarget,
  forceClearReplyOperation,
  registerReplyOperationSuccessorBarrier,
  ReplyRunSuccessorAdmissionBlockedError,
  waitForReplyRunSuccessorAdmission,
  clearReplyRunForResetBySessionId,
  isReplyRunAbortableForCompaction,
  isReplyRunAbortableForSignal,
  isReplyRunActiveForSessionId,
  replyRunRegistry,
  retainReplyOperationUntilComplete,
} from "./reply-run-registry.js";
import {
  resolveActiveReplyRunOwnerForSignal,
  waitForReplyOperationBackend,
} from "./reply-run-registry.state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";

function createRunningOperation(
  upstreamAbortSignal?: AbortSignal,
  overrides: Pick<ReplyBackendHandle, "isStreaming" | "isAbortable"> = {},
) {
  const operation = createTestReplyOperation({ upstreamAbortSignal });
  const cancel = vi.fn();
  const backend = { kind: "embedded" as const, cancel, isStreaming: () => true, ...overrides };
  operation.attachBackend(backend);
  operation.setPhase("running");
  return { operation, cancel, backend };
}

afterEach(() => {
  testing.resetReplyRunRegistry();
  resetCommandQueueStateForTest();
  resetDiagnosticRunActivityForTest();
  vi.restoreAllMocks();
});

describe("reply run registry cancellation", () => {
  it("treats queued reply operations as non-abortable for compaction", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-compact",
    });

    expect(isReplyRunActiveForSessionId("session-compact")).toBe(true);
    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(false);

    operation.markWaitingForDeferredMaintenance();

    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(false);

    operation.markDeferredMaintenanceWaitEnded();
    operation.setPhase("running");

    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(true);
  });

  it("settles aborted global-lane reservations but waits for retained owners and delivery", async () => {
    for (const retained of [false, true]) {
      const operation = createTestReplyOperation({ sessionId: "session-waiting-abort" });
      const delivery = createDeferred();
      const settled = vi.fn();
      void operation.ownerSettlement?.then(settled);
      operation.setPhase("waiting_for_global_lane");
      if (retained) {
        retainReplyOperationUntilComplete(operation);
      }
      try {
        operation.abortByUser();
        expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
        expect(replyRunRegistry.isActive(operation.key)).toBe(retained);
        expect(isReplyRunActiveForSessionId(operation.sessionId)).toBe(retained);
        await Promise.resolve();
        expect(settled).toHaveBeenCalledTimes(retained ? 0 : 1);
        if (retained) {
          operation.completeWithAfterClearBarrier(delivery.promise);
          await Promise.resolve();
          expect(replyRunRegistry.isActive(operation.key)).toBe(false);
          expect(settled).not.toHaveBeenCalled();
          delivery.resolve();
          await operation.ownerSettlement;
          expect(settled).toHaveBeenCalledOnce();
        }
      } finally {
        delivery.resolve();
        operation.complete();
      }
    }
  });

  it("does not reset deferred-maintenance operations as backend-owned work", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-waiting-reset",
    });

    operation.markWaitingForDeferredMaintenance();
    clearReplyRunForResetBySessionId("session-waiting-reset");

    expect(operation.result).toBeNull();
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);
  });

  it("keeps retained terminal failures immutable across late aborts", () => {
    const upstreamAbort = new AbortController();
    const { operation, cancel } = createRunningOperation(upstreamAbort.signal, {
      isStreaming: () => false,
      isAbortable: () => true,
    });
    operation.retainFailureUntilComplete();

    operation.fail("run_failed", new Error("provider failed"));
    upstreamAbort.abort(new Error("late upstream abort"));

    expect(operation.abortSignal.aborted).toBe(false);
    expect(operation.abortByUser()).toBe(false);
    expect(operation.abortForRestart()).toBe(false);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(operation.phase).toBe("failed");
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: undefined,
      code: "aborted_by_user",
      cancelReason: "user_abort",
      direct: false,
    },
    {
      reason: new Error("caller cancelled"),
      code: "aborted_by_user",
      cancelReason: "user_abort",
      direct: false,
    },
    {
      reason: createAgentRunDirectAbortError(),
      code: "aborted_by_user",
      cancelReason: "user_abort",
      direct: true,
    },
    {
      reason: createAgentRunRestartAbortError(),
      code: "aborted_for_restart",
      cancelReason: "restart",
      direct: false,
    },
    {
      reason: createAgentRunSupersededAbortError(),
      code: "aborted_for_supersession",
      cancelReason: "superseded",
      direct: false,
    },
    {
      reason: createAgentRunRestartAbortError(),
      code: "aborted_by_user",
      cancelReason: "user_abort",
      userFirst: true,
      direct: true,
    },
  ])(
    "records cancellation once as $code (userFirst=$userFirst)",
    ({ reason, code, cancelReason, userFirst, direct }) => {
      const upstreamAbort = new AbortController();
      const { operation, cancel } = createRunningOperation(upstreamAbort.signal);
      if (userFirst) {
        expect(operation.abortByUser()).toBe(true);
      }
      upstreamAbort.abort(reason);

      expect(operation.result).toEqual({ kind: "aborted", code });
      expect(operation.phase).toBe("aborted");
      expect(operation.abortSignal.aborted).toBe(true);
      expect(isAgentRunDirectAbortReason(operation.abortSignal.reason)).toBe(direct);
      if (!userFirst) {
        expect(operation.abortSignal.reason).toBe(upstreamAbort.signal.reason);
      }
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith(cancelReason);
      operation.complete();
    },
  );

  it("clears queued ownership when the upstream signal is already aborted", () => {
    const upstreamAbort = new AbortController();
    upstreamAbort.abort(new Error("caller already cancelled"));

    const operation = createTestReplyOperation({
      sessionKey: "agent:main:already-cancelled",
      sessionId: "session-already-cancelled",
      upstreamAbortSignal: upstreamAbort.signal,
    });

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(replyRunRegistry.isActive("agent:main:already-cancelled")).toBe(false);
  });

  it("rejects aborts while the attached backend is finalizing", () => {
    let abortable = false;
    const { operation, cancel } = createRunningOperation(undefined, {
      isStreaming: () => false,
      isAbortable: () => abortable,
    });

    expect(replyRunRegistry.abort(operation.key)).toBe(false);
    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    abortable = true;
    expect(replyRunRegistry.abort(operation.key)).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledWith("user_abort");
  });

  it("keeps abort frozen after the backend detaches for reply delivery", () => {
    const upstreamAbort = new AbortController();
    const { operation, cancel, backend } = createRunningOperation(upstreamAbort.signal, {
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.freezeAbort();
    operation.detachBackend(backend);

    expect(operation.phase).toBe("running");
    expect(isReplyRunAbortableForSignal(upstreamAbort.signal)).toBe(false);
    expect(isReplyRunAbortableForSignal(new AbortController().signal)).toBe(true);
    expect(replyRunRegistry.abort(operation.key)).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    upstreamAbort.abort();
    expect(operation.abortSignal.aborted).toBe(false);

    operation.complete();
    expect(replyRunRegistry.isActive(operation.key)).toBe(false);
    expect(isReplyRunAbortableForSignal(upstreamAbort.signal)).toBe(false);
  });

  it("aborts compacting runs through the registry compatibility helper", () => {
    const faultyOperation = createTestReplyOperation({
      sessionKey: "agent:main:faulty",
      sessionId: "session-faulty",
    });
    faultyOperation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isCompacting: () => {
        throw new Error("compaction probe unavailable");
      },
    });
    faultyOperation.setPhase("running");
    const compactingOperation = createTestReplyOperation({
      sessionId: "session-compacting",
    });
    compactingOperation.setPhase("preflight_compacting");

    const runningOperation = createTestReplyOperation({
      sessionKey: "agent:main:other",
      sessionId: "session-running",
    });
    runningOperation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "compacting" })).toBe(true);
    expect(compactingOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(runningOperation.result).toBeNull();
    expect(faultyOperation.result).toBeNull();
  });
});

describe("reply operation backend readiness", () => {
  it.each(["phase", "backend", "global-lane"] as const)(
    "waits for both startup facts (%s first)",
    async (first) => {
      const operation = createTestReplyOperation();
      const backend = { kind: "embedded" as const, cancel: vi.fn() };
      const markRunning = () => operation.setPhase("running");
      const attach = () => operation.attachBackend(backend);
      if (first === "global-lane") {
        markRunning();
        operation.markWaitingForGlobalLane();
        attach();
      } else {
        (first === "phase" ? markRunning : attach)();
      }
      const settled = vi.fn();
      const ready = waitForReplyOperationBackend(operation).then(settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      if (first === "global-lane") {
        operation.markGlobalLaneWaitEnded();
      } else {
        (first === "phase" ? attach : markRunning)();
      }
      await ready;
      expect(settled).toHaveBeenCalledExactlyOnceWith(true);
      operation.detachBackend(backend);
      await expect(waitForReplyOperationBackend(operation)).resolves.toBe(false);
      operation.complete();
    },
  );

  it("cancels a startup waiter without aborting the owner or another waiter", async () => {
    const operation = createTestReplyOperation();
    const source = new AbortController();
    const cancelled = waitForReplyOperationBackend(operation, source.signal);
    const retained = waitForReplyOperationBackend(operation);
    source.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(operation.abortSignal.aborted).toBe(false);
    expect(replyRunRegistry.get(operation.key)).toBe(operation);
    operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
    operation.setPhase("running");
    await expect(retained).resolves.toBe(true);
    operation.complete();
  });

  it("releases startup waiters when their owner is superseded", async () => {
    const operation = createTestReplyOperation();
    const ready = waitForReplyOperationBackend(operation);
    operation.supersede();
    await expect(ready).resolves.toBe(false);
    operation.complete();
  });

  it("keeps startup waiters bound to their key across rekey and replacement", async () => {
    const operation = createTestReplyOperation();
    const previousKey = operation.key;
    const oldWait = waitForReplyOperationBackend(operation);
    operation.updateSessionKey("agent:main:rekeyed");
    const movedWait = waitForReplyOperationBackend(operation);
    const replacement = createTestReplyOperation({ sessionKey: previousKey });
    replacement.setPhase("running");
    replacement.attachBackend({ kind: "embedded", cancel: vi.fn() });
    await expect(oldWait).resolves.toBe(false);
    operation.setPhase("running");
    operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
    await expect(movedWait).resolves.toBe(true);
    operation.complete();
    replacement.complete();
  });

  it("does not revive an old startup waiter when its owner returns to the same key", async () => {
    const operation = createTestReplyOperation();
    const originalKey = operation.key;
    const retired = waitForReplyOperationBackend(operation);
    operation.updateSessionKey("agent:main:temporary-target");
    operation.updateSessionKey(originalKey);
    const current = waitForReplyOperationBackend(operation);
    operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
    operation.setPhase("running");
    await expect(retired).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    operation.complete();
  });
});

describe("reply run control ownership", () => {
  const sessionKey = "agent:main:voice-control";
  afterEach(() => replyRunRegistry.get(sessionKey)?.complete());
  it.each([false, true])(
    "settles producer handoff before delivery can admit a successor (forced clear=%s)",
    async (forcedClear) => {
      const controller = new AbortController();
      const operation = createTestReplyOperation({
        sessionKey,
        upstreamAbortSignal: controller.signal,
      });
      operation.setPhase("running");
      const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
      const persistence = createDeferred();
      const delivery = createDeferred();
      const started = vi.fn();
      let handoff: Promise<void> | undefined;
      try {
        expect(
          owner?.handoff((producerCompleted) => {
            handoff = producerCompleted.then(async () => {
              started();
              await persistence.promise;
            });
            return handoff;
          }),
        ).toBe(true);

        controller.abort();
        if (forcedClear) {
          expect(forceClearReplyOperation(operation)).toBe(true);
        }
        await Promise.resolve();
        expect(started).not.toHaveBeenCalled();
        expect(() => createTestReplyOperation({ sessionKey })).toThrow();

        operation.completeWithAfterClearBarrier(delivery.promise);
        await Promise.resolve();
        expect(started).toHaveBeenCalledOnce();
        expect(() => createTestReplyOperation({ sessionKey })).toThrow(
          ReplyRunSuccessorAdmissionBlockedError,
        );
        const nextAdmission = waitForReplyRunSuccessorAdmission(operation.key, null);
        persistence.resolve();
        await handoff;
        await expect(nextAdmission).resolves.toMatchObject({ settled: true });

        // Delivery is allowed to depend on a new operation without a settlement cycle.
        const successor = createTestReplyOperation({ sessionKey, sessionId: "successor" });
        successor.complete();
        delivery.resolve();
        await operation.ownerSettlement;
        expect(owner?.handoff(async () => {})).toBe(false);
      } finally {
        persistence.resolve();
        delivery.resolve();
        operation.complete();
        await operation.ownerSettlement;
      }
    },
  );

  it("keeps a mismatched input out of a required reply owner", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "session-reply-expectation",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      terminalReplyExpectation: "required",
      cancel: vi.fn(),
      queueMessage,
    });
    operation.setPhase("running");
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key);
    if (!target) {
      throw new Error("Expected a live message injection target");
    }
    await expect(
      (
        await beginReplyMessageInjectionTarget(target, "different input", {
          terminalReplyExpectation: "optional",
        })
      ).outcome,
    ).resolves.toEqual({ status: "rejected", reason: "reply_expectation_mismatch" });
    expect(queueMessage).not.toHaveBeenCalled();
    await expect(
      (
        await beginReplyMessageInjectionTarget(target, "matching input", {
          terminalReplyExpectation: "required",
        })
      ).outcome,
    ).resolves.toEqual({ status: "accepted" });
    expect(queueMessage).toHaveBeenCalledOnce();
  });

  it.each(["key", "sessionId"] as const)(
    "fences retained controls after its %s changes",
    (field) => {
      const controller = new AbortController();
      const operation = replyRunRegistry.begin({
        sessionKey,
        sessionId: "original-session",
        resetTriggered: false,
        upstreamAbortSignal: controller.signal,
      });
      try {
        const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
        if (field === "key") {
          operation.updateSessionKey("agent:main:voice-control-rekeyed");
        } else {
          operation.updateSessionId("replacement-session");
        }
        expect(owner?.abort()).toBe(false);
        expect(operation.abortSignal.aborted).toBe(false);
      } finally {
        operation.complete();
      }
    },
  );

  it("controls a queued reply only through its admitted upstream signal", () => {
    const controller = new AbortController();
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "queued-session",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    expect(resolveActiveReplyRunOwnerForSignal(new AbortController().signal)).toBeUndefined();
    const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
    expect(owner?.sessionId).toBe("queued-session");
    expect(owner?.abort()).toBe(true);
    expect(operation.abortSignal.aborted).toBe(true);
    expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
  });

  it("fences retained controls after same-session replacement", () => {
    const controller = new AbortController();
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "same-session",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
    operation.complete();
    const successor = replyRunRegistry.begin({
      sessionKey,
      sessionId: "same-session",
      resetTriggered: false,
      upstreamAbortSignal: new AbortController().signal,
    });
    expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
    expect(owner?.abort()).toBe(false);
    expect(successor.abortSignal.aborted).toBe(false);
  });
});

async function withFakeReplyTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    return await run();
  } finally {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  }
}

describe("reply run successor barriers", () => {
  it("fences every durable alias until successor handoff settles", async () => {
    await withFakeReplyTimers(async () => {
      const requestKey = "agent:main:telegram:alias:request";
      const canonicalKey = "agent:main:telegram:alias:canonical";
      const adoptedKey = "agent:main:telegram:alias:adopted";
      const operation = createTestReplyOperation({
        sessionKey: requestKey,
        sessionId: "alias-session",
      });
      const { promise: firstBarrier, resolve: releaseFirstBarrier } = createDeferred();
      registerReplyOperationSuccessorBarrier({
        operation,
        sessionId: "alias-session",
        sessionKeys: [requestKey, canonicalKey],
        start: () => firstBarrier,
      });
      const { promise: secondBarrier, resolve: releaseSecondBarrier } = createDeferred();
      registerReplyOperationSuccessorBarrier({
        operation,
        sessionId: "alias-session",
        sessionKeys: [adoptedKey],
        start: () => secondBarrier,
      });

      operation.updateSessionId("rotated-alias-session");
      operation.complete();
      for (const sessionKey of [requestKey, canonicalKey, adoptedKey]) {
        expect(() => createTestReplyOperation({ sessionKey })).toThrow(
          ReplyRunSuccessorAdmissionBlockedError,
        );
      }
      const timedWait = waitForReplyRunSuccessorAdmission(canonicalKey, 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(timedWait).resolves.toEqual({ settled: false });

      const requestWait = waitForReplyRunSuccessorAdmission(requestKey, 100);
      const canonicalWait = waitForReplyRunSuccessorAdmission(canonicalKey, 100);
      releaseFirstBarrier();
      for (const wait of [requestWait, canonicalWait]) {
        await expect(wait).resolves.toEqual({
          settled: true,
          sources: [
            {
              sessionId: "rotated-alias-session",
              sessionIds: operation.captureOwnedSessionIds(),
              operation,
              databaseIdentity: undefined,
            },
          ],
        });
      }
      expect(() => createTestReplyOperation({ sessionKey: adoptedKey })).toThrow(
        ReplyRunSuccessorAdmissionBlockedError,
      );
      releaseSecondBarrier();
      await expect(waitForReplyRunSuccessorAdmission(adoptedKey, 100)).resolves.toEqual({
        settled: true,
        sources: [
          {
            sessionId: "rotated-alias-session",
            sessionIds: operation.captureOwnedSessionIds(),
            operation,
            databaseIdentity: undefined,
          },
        ],
      });
      const successor = createTestReplyOperation({ sessionKey: canonicalKey });
      successor.complete();
    });
  });

  it("starts a late deferred release and keeps successors fenced after rejection", async () => {
    const operation = createTestReplyOperation();
    operation.complete();
    const entered = createDeferred();
    const release = createDeferred();
    const start = vi.fn(() => {
      entered.resolve();
      return release.promise;
    });
    const controller = new AbortController();
    let wait: ReturnType<typeof waitForReplyRunSuccessorAdmission> | undefined;
    try {
      registerReplyOperationSuccessorBarrier({
        operation,
        sessionId: operation.sessionId,
        sessionKeys: [operation.key],
        deferUntilClear: true,
        start,
      });
      expect(start).toHaveBeenCalledOnce();
      await entered.promise;
      release.reject(new Error("Synthetic late release failure"));
      await Promise.allSettled([release.promise]);
      expect(() => createTestReplyOperation({ sessionKey: operation.key })).toThrow(
        ReplyRunSuccessorAdmissionBlockedError,
      );
      wait = waitForReplyRunSuccessorAdmission(operation.key, null, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(wait).resolves.toEqual({ settled: false });
      expect(() => createTestReplyOperation({ sessionKey: operation.key })).toThrow(
        ReplyRunSuccessorAdmissionBlockedError,
      );
      expect(start).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      release.resolve();
      await Promise.allSettled([release.promise]);
      await wait;
    }
  });
});
