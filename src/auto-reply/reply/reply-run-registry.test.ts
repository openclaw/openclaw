import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { QuestionAnswerUnconfirmedError } from "../../agents/harness/gateway-question-dispatch.js";
import { SessionPendingInputCustodyError } from "../../config/sessions/session-pending-input-custody-error.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  RUN_STALE_TAKEOVER_MS,
} from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticModelStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  hasCommittedReplyOperationOutcome,
  interruptReplyRunTarget,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  type ReplyBackendQueueMessageOptions,
  type ReplyOperation,
  markReplyOperationGlobalLaneWaitProgress,
  runAfterReplyOperationClear,
  waitForReplyOperationOwnerSettlement,
  getSessionControllerOperation as getOperation,
} from "../../sessions/session-controller.js";
import { captureCurrentReplyMessageInjectionTarget as captureInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import * as controllerQueries from "../../sessions/session-controller.queries.js";
import { waitForReplyRunEndBySessionId } from "../../sessions/session-controller.settlement.js";
import { isReplyRunEvidenceStale } from "../../sessions/session-controller.state.js";
import {
  supersedeReplyRunByRunId,
  captureCurrentSessionRunInterruptTarget,
} from "../../sessions/session-controller.stop-runtime.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { SESSION_WATCHDOG_CLEANUP_MS } from "../../sessions/session-controller.watchdog-state.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { beginReplyOperationFinalizationWork } from "./reply-run-finalization-lease.js";
import { registerReplyOperationCompletionCases } from "./reply-run-registry.completion.cases.js";
import { registerReplyOperationRekeyCases } from "./reply-run-registry.rekey.cases.js";
import {
  createTestReplyOperation,
  queueCurrentReplyRunMessage as queueCurrentMessage,
  queueReplyMessageInjectionTarget as queueTargetMessage,
} from "./reply-run-registry.test-helpers.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

type Backend = Parameters<ReplyOperation["attachBackend"]>[0];
type OperationOptions = Parameters<typeof createTestReplyOperation>[0];
const acceptedResult = { status: "accepted" } as const;

function attachBackend(
  operation: ReplyOperation,
  backend: Omit<Backend, "kind" | "cancel"> & Partial<Pick<Backend, "kind" | "cancel">> = {},
) {
  operation.attachBackend({ kind: "embedded", cancel: vi.fn(), ...backend });
  return operation;
}

function runningOperation(
  options: OperationOptions = {},
  backend?: Parameters<typeof attachBackend>[1],
) {
  const operation = createTestReplyOperation(options);
  operation.setPhase("running");
  return backend ? attachBackend(operation, backend) : operation;
}

function injectionOperation(backend: Parameters<typeof attachBackend>[1]) {
  return runningOperation({ originatingLeafEntryId: "leaf-a" }, backend);
}

function observeClear(operation: ReplyOperation) {
  const afterClear = vi.fn();
  runAfterReplyOperationClear(operation, afterClear);
  return afterClear;
}

function observeSettlement(operation: ReplyOperation) {
  const settled = vi.fn();
  void operation.ownerSettlement.then(settled);
  return settled;
}

function storeOperation(sessionId: string, storeScope?: string, options: OperationOptions = {}) {
  return createTestReplyOperation({
    sessionKey: "global",
    sessionId,
    target: storeScope
      ? captureSessionTarget({ storeScope, sessionKey: "global", incarnation: sessionId })
      : undefined,
    ...options,
  });
}

function deliveryCustody(operation: ReplyOperation) {
  const barrier = createDeferred();
  const afterClear = observeClear(operation);
  operation.completeWithAfterClearBarrier(barrier.promise);
  return { barrier, afterClear };
}

function createInjectableOperation(
  sessionId: string,
  queueMessage: Backend["queueMessage"],
  backend: Partial<Backend> = {},
  overrides: Parameters<typeof createTestReplyOperation>[0] = {},
) {
  return runningOperation({ sessionId, ...overrides }, injectableBackend(queueMessage, backend));
}

function injectableBackend(
  queueMessage: Backend["queueMessage"],
  overrides: Partial<Backend> = {},
) {
  return {
    supportsTranscriptCommitWait: true,
    isStreaming: () => true,
    queueMessage,
    ...overrides,
  };
}

function withFakeReplyTimers<Args extends unknown[]>(run: (...args: Args) => Promise<void>) {
  return async (...args: Args) => {
    vi.useFakeTimers();
    try {
      await run(...args);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  };
}

afterEach(() => {
  testing.resetSessionControllerForTest();
  resetCommandQueueStateForTest();
  resetDiagnosticRunActivityForTest();
  vi.restoreAllMocks();
});

it(
  "keeps ownership stable by sessionKey while sessionId rotates",
  withFakeReplyTimers(async () => {
    const operation = createTestReplyOperation({ sessionId: "session-old" });
    const oldWaitPromise = waitForReplyRunEndBySessionId("session-old", 1_000);
    operation.updateSessionId("session-new");
    expect(controllerQueries.isSessionRunActiveForKey("agent:main:main")).toBe(true);
    expect(controllerQueries.resolveActiveSessionRunId("agent:main:main")).toBe("session-new");
    expect(controllerQueries.isSessionRunActive("session-new")).toBe(true);
    const settled = vi.fn();
    void oldWaitPromise.then(settled);
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).not.toHaveBeenCalled();
    operation.complete();
    await expect(oldWaitPromise).resolves.toBe(true);
  }),
);

it("keeps repeated request evidence across reply-operation progress", () => {
  const startedAt = Date.parse("2026-08-06T08:00:00Z");
  const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
  const ref = {
    sessionKey: "agent:main:telegram:direct:retry-bridge",
    sessionId: "session-retry-bridge",
  };
  const runId = "run-retry-bridge";
  markDiagnosticEmbeddedRunStarted({ ...ref, runId });
  const request = {
    ...ref,
    runId,
    provider: "mock",
    model: "request-model",
    observationUnit: "request" as const,
  };
  markDiagnosticModelStartedForTest(request);
  now.mockReturnValue(startedAt + 30_000);
  markDiagnosticModelStartedForTest(request);
  now.mockReturnValue(startedAt + 60_000);
  const operation = createTestReplyOperation(ref);
  expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
    lastProgressReason: "reply_operation:queued",
    repeatedRequestNoProgressAgeMs: 30_000,
  });
  operation.markWaitingForDeferredMaintenance();
  expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
    lastProgressReason: "deferred_maintenance:waiting",
    repeatedRequestNoProgressAgeMs: 30_000,
  });
  operation.complete();
  expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
    lastProgressReason: "reply_operation:ended",
    repeatedRequestNoProgressAgeMs: 30_000,
  });
});

it("keeps a reply alive while the saturated global lane waits past the stale threshold", async () => {
  vi.useFakeTimers();
  const operation = createTestReplyOperation();
  try {
    const lane = "test:reply-global-wait";
    setCommandLaneConcurrency(lane, 0);
    operation.setPhase("running");
    operation.markWaitingForGlobalLane();
    let ran = false;
    const queued = enqueueCommandInLane(
      lane,
      async () => {
        operation.markGlobalLaneWaitEnded();
        ran = true;
      },
      { onWait: () => markReplyOperationGlobalLaneWaitProgress(operation) },
    );
    await vi.advanceTimersByTimeAsync(RUN_STALE_TAKEOVER_MS + 1);
    expect(operation.phase).toBe("waiting_for_global_lane");
    expect(isReplyRunEvidenceStale(operation)).toBe(false);
    expect(ran).toBe(false);
    setCommandLaneConcurrency(lane, 1);
    await queued;
    expect(ran).toBe(true);
    expect(operation.phase).toBe("running");
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: operation.sessionId,
        sessionKey: operation.key,
      }).lastProgressReason,
    ).toBe("global_lane:wait_ended");
  } finally {
    operation.complete();
    vi.useRealTimers();
  }
});

it("runs completeThen callbacks after active state clears", () => {
  const operation = createTestReplyOperation({ sessionId: "session-complete" });
  const afterClear = vi.fn(() => {
    expect(controllerQueries.isSessionRunActiveForKey("agent:main:main")).toBe(false);
    expect(controllerQueries.isSessionRunActive("session-complete")).toBe(false);
  });
  operation.completeThen(afterClear);
  expect(operation.result).toEqual({ kind: "completed" });
  expect(afterClear).toHaveBeenCalledTimes(1);
});

it(
  "keeps late delivery custody after finalization cleanup expires",
  withFakeReplyTimers(async () => {
    const operation = createTestReplyOperation();
    const delivery = createDeferred();
    const settled = observeSettlement(operation);
    operation.setPhase("running");
    operation.freezeAbort();
    try {
      vi.setSystemTime(Date.now() + SESSION_WATCHDOG_CLEANUP_MS);
      await operation.watchdog.tick();
      expect(operation.watchdog.snapshot().recovery?.status).toBe("blocked");
      expect(getOperation(operation.key)).toBe(operation);
      expect(() => createTestReplyOperation({ sessionId: "too-early" })).toThrow();
      expect(settled).not.toHaveBeenCalled();
      const ownerWait = waitForReplyOperationOwnerSettlement(operation, 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(ownerWait).resolves.toBe(false);
      expect(settled).not.toHaveBeenCalled();
      // Completion clears the slot, but delivery still delays queued follow-ups.
      operation.completeWithAfterClearBarrier(delivery.promise);
      expect(() =>
        createTestReplyOperation({ sessionId: "successor", turnKind: "queued_followup" }),
      ).toThrow();
      operation.complete();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(getOperation(operation.key)).toBeUndefined();
      expect(operation.result).toEqual({ kind: "completed" });
      delivery.resolve();
      await operation.ownerSettlement;
      await expect(waitForReplyRunSuccessorAdmission(operation.key)).resolves.toMatchObject({
        settled: true,
      });
      const successor = createTestReplyOperation({ sessionId: "successor" });
      successor.complete();
    } finally {
      delivery.resolve();
      operation.completeWithAfterClearBarrier(delivery.promise);
      await operation.ownerSettlement;
    }
    expect(settled).toHaveBeenCalledOnce();
  }),
);

it("interrupts only the captured operation when its abort admits a same-key successor", async () => {
  const operation = createTestReplyOperation({ sessionId: "session-interrupt-captured" });
  operation.setPhase("running");
  let successor: ReplyOperation | undefined;
  let successorAbortByUser: MockInstance<ReplyOperation["abortByUser"]> | undefined;
  operation.attachBackend({
    kind: "embedded",
    cancel: () => {
      operation.complete();
      successor = createTestReplyOperation({ sessionId: "session-interrupt-successor" });
      successor.setPhase("running");
      successorAbortByUser = vi.spyOn(successor, "abortByUser");
    },
  });
  const target = captureCurrentSessionRunInterruptTarget(operation.key);
  if (!target) {
    throw new Error("expected captured interrupt target");
  }
  await expect(interruptReplyRunTarget(target, 1_000)).resolves.toEqual({
    aborted: true,
    settled: true,
  });
  if (!successor || !successorAbortByUser) {
    throw new Error("expected same-key successor operation");
  }
  try {
    expect(successorAbortByUser).not.toHaveBeenCalled();
  } finally {
    successor.complete();
  }
});

it.each([false, true])(
  "keeps reentrant cancellation completion behind its delivery barrier (cancel throws=%s)",
  async (throwsAfterCompletion) => {
    const operation = createTestReplyOperation({ sessionId: "session-sync-cancel" });
    const delivery = createDeferred();
    const afterClear = observeClear(operation);
    const ownerSettled = observeSettlement(operation);
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: () => {
        operation.completeWithAfterClearBarrier(delivery.promise);
        if (throwsAfterCompletion) {
          throw new Error("cancel failed after producer completion");
        }
      },
    });
    try {
      await expect(
        operation.watchdog.tick(operation.watchdog.snapshot().semanticDeadlineAtMs),
      ).resolves.toMatchObject({ action: "blocked" });
      expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(operation.abortSignal.aborted).toBe(true);
      expect(getOperation(operation.key)).toBeUndefined();
      expect(afterClear).not.toHaveBeenCalled();
      expect(ownerSettled).not.toHaveBeenCalled();
      const lateAfterClear = observeClear(operation);
      expect(lateAfterClear).not.toHaveBeenCalled();
      expect(() =>
        createTestReplyOperation({ sessionId: "successor", turnKind: "queued_followup" }),
      ).toThrow();
      delivery.resolve();
      await operation.ownerSettlement;
      await expect(waitForReplyRunSuccessorAdmission(operation.key)).resolves.toMatchObject({
        settled: true,
      });
      const successor = createTestReplyOperation({ sessionId: "successor" });
      await Promise.resolve();
      expect(afterClear).toHaveBeenCalledExactlyOnceWith("session-sync-cancel");
      expect(lateAfterClear).toHaveBeenCalledExactlyOnceWith("session-sync-cancel");
      expect(ownerSettled).toHaveBeenCalledOnce();
      expect(getOperation(operation.key)).toBe(successor);
      successor.complete();
    } finally {
      delivery.resolve();
      operation.complete();
      await operation.ownerSettlement;
    }
  },
);

it.each(["pending", "throws", "throws undefined", "pre-backend"] as const)(
  "retires exact stale custody at the cleanup deadline when cancellation is %s",
  async (cancellation) => {
    const operation = createTestReplyOperation({ sessionId: "session-cancel-pending" });
    const revokeWriter = vi.fn(async () => true);
    operation.registerTerminalProducerFence(revokeWriter);
    operation.setPhase("running");
    const cancel = vi.fn(() => {
      if (cancellation === "throws") {
        throw new Error("cancel failed");
      }
      if (cancellation === "throws undefined") {
        // oxlint-disable-next-line typescript/only-throw-error -- JavaScript cancellation can throw any value; custody must survive it.
        throw undefined;
      }
    });
    if (cancellation !== "pre-backend") {
      operation.attachBackend({ kind: "embedded", cancel });
    }
    const afterClear = observeClear(operation);
    const ownerSettled = observeSettlement(operation);
    const deadline = operation.watchdog.snapshot().semanticDeadlineAtMs;
    await expect(operation.watchdog.tick(deadline)).resolves.toMatchObject({ action: "blocked" });
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(operation.abortSignal.aborted).toBe(true);
    expect(getOperation(operation.key)).toBe(operation);
    expect(cancel).toHaveBeenCalledTimes(cancellation === "pre-backend" ? 0 : 1);
    if (cancellation !== "pre-backend") {
      expect(cancel).toHaveBeenCalledWith("superseded");
    }
    const lateCancel = vi.fn();
    operation.attachBackend({ kind: "embedded", cancel: lateCancel });
    expect(lateCancel).toHaveBeenCalledWith("superseded");
    const lateAfterClear = observeClear(operation);
    await expect(
      operation.watchdog.tick(deadline + SESSION_WATCHDOG_CLEANUP_MS),
    ).resolves.toMatchObject({ action: "expire_cleanup" });
    expect(getOperation(operation.key)).toBeUndefined();
    expect(afterClear).toHaveBeenCalledExactlyOnceWith("session-cancel-pending");
    expect(lateAfterClear).toHaveBeenCalledExactlyOnceWith("session-cancel-pending");
    await operation.ownerSettlement;
    expect(revokeWriter).toHaveBeenCalledOnce();
    expect(ownerSettled).toHaveBeenCalledOnce();
    const successor = createTestReplyOperation({ sessionId: "successor" });
    operation.complete();
    expect(getOperation(operation.key)).toBe(successor);
    successor.complete();
  },
);

it.each([
  { firstStore: "store-a", laterStore: "store-a" },
  { firstStore: "store-a", laterStore: "store-b" },
  { firstStore: "store-a", laterStore: undefined },
  { firstStore: undefined, laterStore: "store-b" },
  { firstStore: undefined, laterStore: undefined },
])(
  "keeps after-clear custody scoped to its physical store ($firstStore -> $laterStore)",
  async ({ firstStore, laterStore }) => {
    const makeOperation = (storeScope: string | undefined) =>
      storeOperation("first-session", storeScope, { turnKind: "queued_followup" });
    const first = makeOperation(firstStore);
    const { barrier, afterClear } = deliveryCustody(first);
    try {
      if (firstStore && laterStore && firstStore !== laterStore) {
        const later = makeOperation(laterStore);
        later.updateSessionId("rotated-session");
        later.complete();
      } else {
        // Unbound metadata cannot manufacture a foreign physical session.
        expect(() => makeOperation(laterStore)).toThrow();
      }
      expect(afterClear).not.toHaveBeenCalled();
    } finally {
      barrier.resolve();
      await first.ownerSettlement;
    }
    expect(afterClear).toHaveBeenCalledExactlyOnceWith("first-session");
  },
);

it("keeps a late callback behind its own delivery when a foreign store has another barrier", async () => {
  const first = storeOperation("first-session", "store-a");
  const firstBarrier = createDeferred();
  first.completeWithAfterClearBarrier(firstBarrier.promise);
  const later = storeOperation("later-session", "store-b");
  const laterBarrier = createDeferred();
  later.completeWithAfterClearBarrier(laterBarrier.promise);
  const afterClear = observeClear(first);
  const laterAfterClear = observeClear(later);
  try {
    expect(afterClear).not.toHaveBeenCalled();
    firstBarrier.resolve();
    await first.ownerSettlement;
    expect(afterClear).toHaveBeenCalledExactlyOnceWith("first-session");
    expect(laterAfterClear).not.toHaveBeenCalled();
  } finally {
    firstBarrier.resolve();
    laterBarrier.resolve();
    await Promise.all([first.ownerSettlement, later.ownerSettlement]);
  }
  expect(laterAfterClear).toHaveBeenCalledExactlyOnceWith("later-session");
});

it("keeps later after-clear work behind earlier delivery custody", async () => {
  const first = createTestReplyOperation({ sessionId: "first-session" });
  const { barrier: firstBarrier, afterClear: firstAfterClear } = deliveryCustody(first);
  const second = createTestReplyOperation({ sessionId: "second-session" });
  const { barrier: secondBarrier, afterClear: secondAfterClear } = deliveryCustody(second);
  expect(secondAfterClear).not.toHaveBeenCalled();
  secondBarrier.resolve();
  await second.ownerSettlement;
  expect(secondAfterClear).not.toHaveBeenCalled();
  expect(firstAfterClear).not.toHaveBeenCalled();
  firstBarrier.resolve();
  await first.ownerSettlement;
  await vi.waitFor(() => {
    expect(firstAfterClear).toHaveBeenCalledExactlyOnceWith("first-session");
    expect(secondAfterClear).toHaveBeenCalledExactlyOnceWith("second-session");
  });
});

it.each(["slow-delivery", "inter-block-delay", "bounded"] as const)(
  "gates follow-up admission on %s while retaining raw delivery settlement",
  withFakeReplyTimers(async (mode: "slow-delivery" | "inter-block-delay" | "bounded") => {
    const operation = createTestReplyOperation({ sessionId: "delivery-session" });
    const delivery = createDeferred();
    const ownerSettled = observeSettlement(operation);
    expect(operation.ownerSettlement).toBeDefined();
    const afterClear = observeClear(operation);
    let pendingBlocks = true;
    const timeout =
      mode === "slow-delivery"
        ? 35 * 60_000
        : mode === "inter-block-delay"
          ? {
              maxTimeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS * 3,
              shouldExtend: () => pendingBlocks,
            }
          : undefined;
    operation.completeWithAfterClearBarrier(delivery.promise, timeout);
    const followup = () =>
      createTestReplyOperation({ sessionId: "followup", turnKind: "queued_followup" });
    try {
      await vi.advanceTimersByTimeAsync(
        REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS - (mode === "bounded" ? 1 : 0),
      );
      expect(afterClear).not.toHaveBeenCalled();
      if (mode === "bounded") {
        await vi.advanceTimersByTimeAsync(1);
      } else {
        if (mode === "slow-delivery") {
          expect(followup).toThrow("Reply follow-up admission is blocked");
          delivery.resolve();
          await delivery.promise;
        } else {
          expect(followup).toThrow();
          pendingBlocks = false;
          await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
        }
        await vi.waitFor(() => expect(afterClear).toHaveBeenCalledWith("delivery-session"));
      }
      expect(afterClear).toHaveBeenCalledWith("delivery-session");
      followup().complete();
      if (mode === "bounded") {
        expect(ownerSettled).not.toHaveBeenCalled();
        const boundedWait = waitForReplyOperationOwnerSettlement(operation, 100);
        await vi.advanceTimersByTimeAsync(100);
        await expect(boundedWait).resolves.toBe(false);
        expect(ownerSettled).not.toHaveBeenCalled();
      }
    } finally {
      delivery.resolve();
      await operation.ownerSettlement;
    }
    expect(ownerSettled).toHaveBeenCalledOnce();
  }),
);

it("retains failed operations until final delivery completes", () => {
  const operation = createTestReplyOperation({ sessionId: "session-failed" });
  const afterClear = observeClear(operation);
  operation.fail("run_failed", new Error("provider failed"));
  expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
  expect(getOperation("agent:main:main")).toBe(operation);
  expect(afterClear).not.toHaveBeenCalled();
  operation.complete();
  expect(controllerQueries.isSessionRunActiveForKey("agent:main:main")).toBe(false);
  expect(afterClear).toHaveBeenCalledTimes(1);
});

it.each([
  ["aborted_by_user", "user_abort", "queued", "abortByUser"],
  ["aborted_for_restart", "restart", "running", "abortForRestart"],
] as const)(
  "preserves cleanup when backend cancellation throws: %s",
  async (code, reason, phase, abort) => {
    await withFakeReplyTimers(async () => {
      const cancelError = new Error("cancel failed");
      const cancel = vi.fn(() => {
        throw cancelError;
      });
      const operation = createTestReplyOperation({
        sessionKey: `agent:main:${reason}-${phase}`,
        sessionId: `session-${reason}-${phase}`,
      });
      const revokeWriter = vi.fn(async () => true);
      operation.registerTerminalProducerFence(revokeWriter);
      operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
      operation.setPhase(phase);
      const afterClear = observeClear(operation);
      expect(() => operation[abort]()).toThrow(cancelError);
      expect(operation.result).toEqual({ kind: "aborted", code });
      expect(operation.phase).toBe("aborted");
      expect(operation.abortSignal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledWith(reason);
      expect(getOperation(operation.key)).toBe(operation);
      expect(afterClear).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_CLEANUP_MS);
      expect(operation.watchdog.snapshot().recovery?.status).toBe("settled");
      expect(getOperation(operation.key)).toBeUndefined();
      expect(afterClear).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenLastCalledWith("superseded");
      expect(revokeWriter).toHaveBeenCalledOnce();
      operation.complete();
      expect(controllerQueries.isSessionRunActiveForKey(operation.key)).toBe(false);
      expect(afterClear).toHaveBeenCalledOnce();
    })();
  },
);

it(
  "admits a visible successor after an aborted producer misses its cleanup deadline",
  withFakeReplyTimers(async () => {
    const cancel = vi.fn();
    const operation = runningOperation({}, { cancel, isStreaming: () => true });
    const revokeWriter = vi.fn(async () => true);
    operation.registerTerminalProducerFence(revokeWriter);
    const afterClear = observeClear(operation);
    operation.abortByUser();
    let next: Awaited<ReturnType<typeof admitReplyTurn>> | undefined;
    void admitReplyTurn({
      sessionKey: operation.key,
      sessionId: "session-after-hung-abort",
      kind: "visible",
      resetTriggered: false,
    }).then((result) => {
      next = result;
    });
    await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_CLEANUP_MS - 1);
    expect(getOperation(operation.key)).toBe(operation);
    expect(afterClear).not.toHaveBeenCalled();
    expect(next).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(next?.status).toBe("owned");
    expect(getOperation(operation.key)).toBe(next?.status === "owned" ? next.operation : undefined);
    expect(afterClear).toHaveBeenCalledTimes(1);
    expect(revokeWriter).toHaveBeenCalledOnce();
    operation.complete();
    if (next?.status === "owned") {
      expect(getOperation(operation.key)).toBe(next.operation);
      next.operation.complete();
    }
  }),
);

it("keeps run_stalled attribution and ownership when cancel re-enters abortByUser", () => {
  const operation = createTestReplyOperation();
  attachBackend(operation, {
    // Mirrors the run loop's abort handler: backend cancellation propagates
    // synchronously back into a user-shaped abort on the same operation.
    cancel: () => {
      operation.abortByUser();
    },
    isStreaming: () => true,
  });
  operation.setPhase("running");
  expect(operation.abortForStall()).toBe(true);
  expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
  expect(getOperation(operation.key)).toBe(operation);
  operation.complete();
  expect(getOperation(operation.key)).toBeUndefined();
});

it.each(["reentrant", "abort-frozen", "retained-terminal"] as const)(
  "preserves supersession custody for a %s owner",
  (state) => {
    const terminal = state === "retained-terminal";
    const order: string[] = [];
    const beforeSupersede = vi.fn(() => order.push("record"));
    const operation = createTestReplyOperation({ turnKind: terminal ? undefined : "heartbeat" });
    const cancel = vi.fn((reason) => {
      order.push(`cancel:${reason}`);
      if (state === "reentrant") {
        operation.abortByUser();
      }
    });
    attachBackend(operation, {
      kind: terminal ? "cli" : "embedded",
      runId: "supersession-run",
      cancel,
      ...(terminal ? {} : { isStreaming: () => true }),
    });
    operation.setPhase("running");
    if (terminal) {
      operation.fail("run_failed", new Error("delivery pending"));
    }
    if (state === "abort-frozen") {
      operation.freezeAbort();
    }
    expect(supersedeReplyRunByRunId("supersession-run", beforeSupersede)).toBe(!terminal);
    expect(beforeSupersede).toHaveBeenCalledTimes(terminal ? 0 : 1);
    if (state === "reentrant") {
      expect(cancel).toHaveBeenCalledWith("superseded");
      expect(order).toEqual(["record", "cancel:superseded"]);
    } else {
      expect(cancel).not.toHaveBeenCalled();
    }
    if (terminal) {
      expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    } else {
      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_supersession" });
    }
  },
);

it(
  "cancels terminal settle when the owner clears state first",
  withFakeReplyTimers(async () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const operation = runningOperation({}, {});
    operation.abortByUser();
    operation.complete();
    await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_CLEANUP_MS);
    expect(controllerQueries.isSessionRunActiveForKey(operation.key)).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(operation.watchdog.snapshot().current).toBe(false);
  }),
);

it("does not let an old watchdog clear a replacement operation", async () => {
  const original = createTestReplyOperation({ sessionId: "session-reused" });
  original.complete();
  const replacement = createTestReplyOperation({ sessionId: "session-reused" });
  await expect(original.watchdog.tick(Number.MAX_SAFE_INTEGER)).resolves.toEqual({
    action: "observe",
    reason: "retired",
  });
  expect(replacement.result).toBeNull();
  expect(controllerQueries.isSessionRunActive("session-reused")).toBe(true);
  replacement.complete();
});

it("reports a committed terminal outcome only while delivery is still finalizing", () => {
  const operation = runningOperation();
  expect(hasCommittedReplyOperationOutcome(operation)).toBe(false);
  operation.freezeAbort();
  expect(hasCommittedReplyOperationOutcome(operation)).toBe(true);
  operation.complete();
  expect(hasCommittedReplyOperationOutcome(operation)).toBe(false);
});

it.each([
  ["stalled owner", "none", false, 59_999, 1],
  ["owner progress", "none", true, 15_000, 45_000],
  ["work before finalization", "before", false, 60_000, 30_000],
  ["activity during bounded work", "after", true, 60_000, 15_000],
] as const)(
  "expires finalization at the longest active deadline: %s",
  async (_name, work, activity, beforeExpiry, remaining) => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation();
      operation.setPhase("running");
      attachBackend(operation, { cancel: () => operation.complete() });
      const afterClear = observeClear(operation);
      if (work === "before") {
        beginReplyOperationFinalizationWork(operation, SESSION_WATCHDOG_CLEANUP_MS * 2);
        await vi.advanceTimersByTimeAsync(30_000);
      }
      operation.freezeAbort();
      if (work === "after") {
        beginReplyOperationFinalizationWork(operation, SESSION_WATCHDOG_CLEANUP_MS * 2);
      }
      if (activity) {
        await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_CLEANUP_MS - 15_000);
        operation.watchdog.progress("finalization");
      }
      await vi.advanceTimersByTimeAsync(beforeExpiry);
      expect(getOperation(operation.key)).toBe(operation);
      expect(operation.result).toBeNull();
      expect(operation.abortSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(remaining);
      expect(getOperation(operation.key)).toBeUndefined();
      expect(operation.result).toEqual({ kind: "completed" });
      expect(operation.phase).toBe("completed");
      expect(operation.abortSignal.aborted).toBe(false);
      expect(afterClear).toHaveBeenCalledTimes(1);
    })();
  },
);

it.each([MAX_TIMER_TIMEOUT_MS + 1, null])(
  "waits for completion with timeout %s",
  withFakeReplyTimers(async (timeout: number | null) => {
    const operation = createTestReplyOperation({ sessionId: "session-running" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const waitPromise = waitForReplyRunEndBySessionId("session-running", timeout);
    if (timeout === null) {
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } else {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    }
    operation.complete();
    await expect(waitPromise).resolves.toBe(true);
  }),
);

it("queues messages only through the active running backend", async () => {
  const queueMessage = vi.fn(async () => {});
  const operation = createTestReplyOperation({ sessionId: "session-running" });
  attachBackend(operation, injectableBackend(queueMessage));
  await expect(queueCurrentMessage("session-running", "before running")).resolves.toMatchObject({
    status: "rejected",
  });
  operation.setPhase("running");
  await expect(queueCurrentMessage("session-running", "hello")).resolves.toEqual(acceptedResult);
  expect(queueMessage).toHaveBeenCalledWith(
    "hello",
    expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
  );
});

it("queues messages only when the task-suggestion tool surface matches", async () => {
  const queueMessage = vi.fn(async () => {});
  createInjectableOperation("session-task-suggestions", queueMessage, {
    taskSuggestionDeliveryMode: "gateway",
  });
  await expect(
    queueCurrentMessage("session-task-suggestions", "legacy client", {
      taskSuggestionDeliveryMode: undefined,
    }),
  ).resolves.toEqual({ status: "rejected", reason: "task_suggestion_delivery_mode_mismatch" });
  await expect(
    queueCurrentMessage("session-task-suggestions", "capable client", {
      taskSuggestionDeliveryMode: "gateway",
    }),
  ).resolves.toEqual(acceptedResult);
  await expect(
    queueCurrentMessage("session-task-suggestions", "internal completion"),
  ).resolves.toEqual(acceptedResult);
  expect(queueMessage).toHaveBeenCalledTimes(2);
  expect(queueMessage).toHaveBeenNthCalledWith(
    1,
    "capable client",
    expect.objectContaining({
      taskSuggestionDeliveryMode: "gateway",
      onQueueAccepted: expect.any(Function),
    }),
  );
  expect(queueMessage).toHaveBeenNthCalledWith(
    2,
    "internal completion",
    expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
  );
});

it.each([
  { images: [{ type: "image" as const, data: "png", mimeType: "image/png" }] },
  { media: [{ path: "/tmp/stored.png", contentType: "image/png" }] },
  { imageOrder: ["offloaded" as const] },
])("queues image inputs only through backends that preserve them: %j", async (input) => {
  const queueMessage = vi.fn(async () => {});
  const operation = createInjectableOperation("session-images", queueMessage);
  await expect(queueCurrentMessage("session-images", "inspect", input)).resolves.toMatchObject({
    status: "rejected",
    reason: "image_input_unsupported",
  });
  expect(queueMessage).not.toHaveBeenCalled();
  attachBackend(operation, injectableBackend(queueMessage, { supportsQueueMessageImages: true }));
  await expect(queueCurrentMessage("session-images", "inspect", input)).resolves.toEqual(
    acceptedResult,
  );
  expect(queueMessage).toHaveBeenCalledWith(
    "inspect",
    expect.objectContaining({ ...input, onQueueAccepted: expect.any(Function) }),
  );
});

it("refuses stale injectable owners for admission and delivery until activity resumes", async () => {
  vi.useFakeTimers();
  try {
    const queueMessage = vi.fn(async () => {});
    const operation = createInjectableOperation(
      "session-running",
      queueMessage,
      { isStreaming: () => false, isStopped: () => false },
      { originatingLeafEntryId: "leaf-a" },
    );
    const target = captureInjectionTarget("agent:main:main");
    expect(target).toBeDefined();
    vi.setSystemTime(operation.watchdog.snapshot().semanticDeadlineAtMs);
    expect(captureInjectionTarget("agent:main:main")).toBeUndefined();
    await expect(queueTargetMessage(target!, "stale")).resolves.toMatchObject({
      status: "rejected",
      reason: "stale_run",
    });
    expect(queueMessage).not.toHaveBeenCalled();
    operation.watchdog.progress("semantic");
    expect(captureInjectionTarget("agent:main:main")).toBeDefined();
    await expect(queueTargetMessage(target!, "fresh")).resolves.toEqual(acceptedResult);
    expect(queueMessage).toHaveBeenCalledWith(
      "fresh",
      expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
    );
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { probe: "isStopped", throws: false },
  { probe: "isStopped", throws: true },
  { probe: "isCompacting", throws: true },
])("fails closed for backend $probe (throws: $throws)", async ({ probe, throws }) => {
  const queueMessage = vi.fn(async () => {});
  createInjectableOperation("session-running", queueMessage, {
    [probe]: () => {
      if (throws) {
        throw new Error("bad stopped state");
      }
      return true;
    },
  });
  await expect(queueCurrentMessage("session-running", "hello")).resolves.toMatchObject({
    status: "rejected",
    reason: "injection_unavailable",
  });
  expect(queueMessage).not.toHaveBeenCalled();
});

it("requires a real injection capability", () => {
  const operation = injectionOperation({ kind: "cli", runId: "run-a" });
  expect(captureInjectionTarget(operation.key)).toBeUndefined();
});

it.each([
  { source: "sync", unconfirmed: false },
  { source: "async", unconfirmed: true },
  { source: "mismatched-question", unconfirmed: false },
  { source: "mismatched-question", unconfirmed: true },
] as const)(
  "distinguishes rejection from non-replayable input: $source (unconfirmed=$unconfirmed)",
  async ({ source, unconfirmed }) => {
    const cause = new Error(`${source} rejection`);
    const error = unconfirmed ? new QuestionAnswerUnconfirmedError(cause) : cause;
    const queueMessage = vi.fn((): Promise<void> => {
      if (source === "sync") {
        throw error;
      }
      return Promise.reject(error);
    });
    const claimPendingUserInputAnswer = vi.fn(async () => {
      throw error;
    });
    const operation = injectionOperation({
      supportsTranscriptCommitWait: true,
      runId: "run-a",
      toolAuthorityFingerprint: "active-authority",
      claimPendingUserInputAnswer,
      messageInjection: { isAvailable: () => true, queueMessage },
    });
    const target = captureInjectionTarget(operation.key)!;
    const confirmSteerTargetRunIdForPersistence = vi.fn(async () => {});
    const recorder = {
      ...createUserTurnTranscriptRecorder({
        input: { text: "answer" },
        target: createTestUserTurnTranscriptTarget(),
      }),
      confirmSteerTargetRunIdForPersistence,
    };
    const onQueueAccepted = vi.fn();
    const mismatch = source === "mismatched-question";
    const attempt = await beginReplyMessageInjectionTarget(target, "answer", {
      isInboundUserMessage: true,
      toolAuthorityFingerprint: mismatch ? "incoming-authority" : "active-authority",
      pendingInputAuthorityFingerprint: "active-authority",
      waitForTranscriptCommit: true,
      userTurnTranscriptRecorder: recorder,
      onQueueAccepted,
    });
    await expect(attempt.acceptance).resolves.toBe(unconfirmed);
    if (unconfirmed) {
      await expect(attempt.outcome).resolves.toEqual({
        status: "indeterminate",
        errorMessage: error.message,
      });
      expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
    } else {
      await expect(attempt.outcome).resolves.toMatchObject({
        status: "rejected",
        reason: "runtime_rejected",
        errorMessage: String(error),
      });
    }
    expect(confirmSteerTargetRunIdForPersistence).not.toHaveBeenCalled();
    expect(queueMessage).toHaveBeenCalledTimes(mismatch ? 0 : 1);
    expect(claimPendingUserInputAnswer).toHaveBeenCalledTimes(mismatch ? 1 : 0);
  },
);

it.each(["callback", "queue-fulfilled", "queue-rejected"] as const)(
  "reports acceptance through %s and composes the caller callback",
  async (source) => {
    const delivery = createDeferred();
    const callerOnQueueAccepted = vi.fn();
    let queueOptions: ReplyBackendQueueMessageOptions | undefined;
    const operation = injectionOperation({
      runId: "run-a",
      messageInjection: {
        isAvailable: () => true,
        queueMessage: vi.fn((_text, options) => {
          queueOptions = options;
          return delivery.promise;
        }),
      },
    });
    const target = captureInjectionTarget(operation.key)!;
    const attempt = await beginReplyMessageInjectionTarget(target, "input", {
      onQueueAccepted: callerOnQueueAccepted,
    });
    const outcomeSettled = vi.fn();
    void attempt.outcome.then(outcomeSettled);
    if (source === "callback") {
      queueOptions?.onQueueAccepted?.(true);
      await expect(attempt.acceptance).resolves.toBe(true);
      expect(callerOnQueueAccepted).toHaveBeenCalledWith(true);
      expect(outcomeSettled).not.toHaveBeenCalled();
    }
    const accepted = source !== "queue-rejected";
    if (accepted) {
      delivery.resolve();
    } else {
      delivery.reject(new Error("rejected"));
    }
    await expect(attempt.acceptance).resolves.toBe(accepted);
    expect(callerOnQueueAccepted).toHaveBeenCalledExactlyOnceWith(accepted);
    await expect(attempt.outcome).resolves.toMatchObject({
      status: accepted ? "accepted" : "rejected",
    });
  },
);

it.each(
  (["direct", "wrapped", "unconfirmed"] as const).flatMap((failure) =>
    [false, true].map((bound) => ({ failure, bound })),
  ),
)(
  "preserves accepted custody failure semantics ($failure, bound: $bound)",
  async ({ failure, bound }) => {
    const custodyError = new SessionPendingInputCustodyError(
      "Pending input ownership ended; submit a new turn to continue",
    );
    expect(custodyError.name).toBe("Error");
    expect(String(custodyError)).toBe(
      "Error: Pending input ownership ended; submit a new turn to continue",
    );
    const error =
      failure === "wrapped"
        ? new Error("Runtime persistence failed", { cause: custodyError })
        : failure === "unconfirmed"
          ? new QuestionAnswerUnconfirmedError(custodyError)
          : custodyError;
    const delivery = createDeferred();
    let sourceCurrent = true;
    const sourceAuthority = vi.fn(() => {
      if (!sourceCurrent) {
        throw new Error("Source authority closed after acceptance");
      }
    });
    const cancel = vi.fn();
    const operation = injectionOperation({
      supportsTranscriptCommitWait: true,
      runId: "run-a",
      cancel,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: (_text, options, assertCurrent) => {
          assertCurrent();
          options?.onQueueAccepted?.(true);
          return delivery.promise;
        },
      },
    });
    const target = captureInjectionTarget(operation.key)!;
    const onQueueAccepted = vi.fn();
    const attempt = await beginReplyMessageInjectionTarget(target, "accepted input", {
      ...(bound ? { assertCurrent: sourceAuthority } : {}),
      onQueueAccepted,
    });
    await expect(attempt.acceptance).resolves.toBe(true);
    const sourceChecks = sourceAuthority.mock.calls.length;
    expect(sourceChecks > 0).toBe(bound);
    sourceCurrent = false;
    delivery.reject(error);
    await expect(attempt.outcome).resolves.toEqual({
      status: "indeterminate",
      errorMessage: error.message,
    });
    await expect(finalizeReplyMessageInjectionAttempt({ attempt, target })).resolves.toMatchObject({
      status: "indeterminate",
    });
    await expect(attempt.acceptance).resolves.toBe(true);
    expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
    expect(sourceAuthority).toHaveBeenCalledTimes(sourceChecks);
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.result).toBeNull();
  },
);

it("rejects an ABA successor even when key and leaf are reused", async () => {
  const first = injectionOperation({
    supportsTranscriptCommitWait: true,
    runId: "run-a",
    messageInjection: { isAvailable: () => true, queueMessage: vi.fn(async () => {}) },
  });
  const target = captureInjectionTarget(first.key)!;
  first.complete();
  const successorQueue = vi.fn(async () => {});
  injectionOperation({
    supportsTranscriptCommitWait: true,
    runId: "run-a",
    messageInjection: { isAvailable: () => true, queueMessage: successorQueue },
  });
  await expect(queueTargetMessage(target, "must not move")).resolves.toMatchObject({
    status: "rejected",
    reason: "no_active_run",
  });
  expect(successorQueue).not.toHaveBeenCalled();
});

it("keeps an invoked queue authoritative when the owner clears synchronously", async () => {
  const operation = runningOperation({ originatingLeafEntryId: "leaf-a" });
  const queueMessage = vi.fn(async () => {
    operation.complete();
  });
  attachBackend(operation, {
    supportsTranscriptCommitWait: true,
    runId: "run-a",
    messageInjection: { isAvailable: () => true, queueMessage },
  });
  const target = captureInjectionTarget(operation.key)!;
  await expect(queueTargetMessage(target, "last input")).resolves.toEqual(acceptedResult);
  expect(controllerQueries.isSessionRunActiveForKey(operation.key)).toBe(false);
});

registerReplyOperationCompletionCases();
registerReplyOperationRekeyCases();
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
