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
import type { ReplyBackendHandle } from "../../sessions/session-controller.contracts.js";
import {
  abortActiveReplyRuns,
  captureReplyMessageInjectionTarget,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  captureSessionControllerSettlement,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { canInjectReplyMessageTarget } from "../../sessions/session-controller.message-injection.js";
import {
  isSessionRunActive,
  isSessionRunActiveForKey,
} from "../../sessions/session-controller.queries.js";
import { waitForReplyOperationBackend } from "../../sessions/session-controller.state.js";
import { clearReplyRunForResetBySessionId } from "../../sessions/session-controller.stop-runtime.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { requestCurrentSessionStop } from "./reply-run-stop.test-support.js";

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

function expectActive(operation: ReturnType<typeof createTestReplyOperation>, active: boolean) {
  expect(isSessionRunActiveForKey(operation.key)).toBe(active);
  expect(isSessionRunActive(operation.sessionId)).toBe(active);
}

afterEach(() => {
  testing.resetSessionControllerForTest();
  resetCommandQueueStateForTest();
  resetDiagnosticRunActivityForTest();
  vi.restoreAllMocks();
});

describe("reply run registry cancellation", () => {
  it("retains deferred-maintenance custody until its aborted producer completes", () => {
    const operation = createTestReplyOperation({ sessionId: "session-waiting-abort" });

    operation.markWaitingForDeferredMaintenance();
    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expectActive(operation, true);
    expect(() => createTestReplyOperation()).toThrow();
    operation.complete();
    expectActive(operation, false);
  });

  it("retains an aborted global-lane reservation through producer and delivery settlement", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-global-lane-abort" });
    const delivery = createDeferred();
    const settled = vi.fn();
    void operation.ownerSettlement.then(settled);
    operation.markWaitingForGlobalLane();
    try {
      operation.abortByUser();
      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expectActive(operation, true);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();

      operation.completeWithAfterClearBarrier(delivery.promise);
      await Promise.resolve();
      expect(isSessionRunActiveForKey(operation.key)).toBe(false);
      expect(settled).not.toHaveBeenCalled();
      delivery.resolve();
      await operation.ownerSettlement;
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      delivery.resolve();
      operation.complete();
    }
  });

  it("does not reset deferred-maintenance operations as backend-owned work", () => {
    const operation = createTestReplyOperation({ sessionId: "session-waiting-reset" });

    operation.markWaitingForDeferredMaintenance();
    clearReplyRunForResetBySessionId("session-waiting-reset");

    expect(operation.result).toBeNull();
    expect(isSessionRunActiveForKey("agent:main:main")).toBe(true);
  });

  it("keeps retained terminal failures immutable across late aborts", () => {
    const upstreamAbort = new AbortController();
    const { operation, cancel } = createRunningOperation(upstreamAbort.signal, {
      isStreaming: () => false,
      isAbortable: () => true,
    });

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
    [new Error("caller cancelled"), "aborted_by_user", "user_abort", false, false],
    [createAgentRunDirectAbortError(), "aborted_by_user", "user_abort", true, false],
    [createAgentRunRestartAbortError(), "aborted_for_restart", "restart", false, false],
    [createAgentRunSupersededAbortError(), "aborted_for_supersession", "superseded", false, false],
    [createAgentRunRestartAbortError(), "aborted_by_user", "user_abort", true, true],
  ] as const)(
    "records cancellation %s as %s (%s, direct=%s, userFirst=%s)",
    (reason, code, cancelReason, direct, userFirst) => {
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
      expect(cancel).toHaveBeenCalledExactlyOnceWith(cancelReason);
      operation.complete();
    },
  );

  it("retains already-aborted queued ownership until its producer completes", () => {
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
    expect(isSessionRunActiveForKey("agent:main:already-cancelled")).toBe(true);
    expect(() => createTestReplyOperation({ sessionKey: operation.key })).toThrow();
    operation.complete();
    expect(isSessionRunActiveForKey("agent:main:already-cancelled")).toBe(false);
  });

  it("rejects aborts while the attached backend is finalizing", async () => {
    let abortable = false;
    const { operation, cancel } = createRunningOperation(undefined, {
      isStreaming: () => false,
      isAbortable: () => abortable,
    });

    expect(await requestCurrentSessionStop(operation.key)).toBe(false);
    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    abortable = true;
    expect(await requestCurrentSessionStop(operation.key)).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledWith("user_abort");
  });

  it("keeps abort frozen after the backend detaches for reply delivery", async () => {
    const upstreamAbort = new AbortController();
    const { operation, cancel, backend } = createRunningOperation(upstreamAbort.signal, {
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.freezeAbort();
    operation.detachBackend(backend);

    expect(operation.phase).toBe("running");
    expect(await requestCurrentSessionStop(operation.key)).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    upstreamAbort.abort();
    expect(operation.abortSignal.aborted).toBe(false);

    operation.complete();
    expect(isSessionRunActiveForKey(operation.key)).toBe(false);
  });

  it("aborts only compacting runs selected by the controller", () => {
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
    const compactingOperation = createTestReplyOperation({ sessionId: "session-compacting" });
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
  it("waits for the same logical owner's next backend when input arrives during recovery", async () => {
    const { operation, backend } = createRunningOperation();
    const nextBackend = {
      kind: "embedded" as const,
      runId: "recovered-attempt",
      cancel: vi.fn(),
      queueMessage: vi.fn(async () => {}),
    };
    const settled = vi.fn();
    try {
      await expect(waitForReplyOperationBackend(operation)).resolves.toBe(true);
      operation.detachBackend(backend);
      // No attachment was captured by this incoming input. It may wait for this
      // exact logical owner; it must not select a replacement operation by key.
      expect(captureReplyMessageInjectionTarget(operation)).toBeUndefined();
      const readiness = waitForReplyOperationBackend(operation).then((ready) => {
        settled(ready);
        return ready ? captureReplyMessageInjectionTarget(operation) : undefined;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      operation.attachBackend(nextBackend);
      const selected = await readiness;
      expect(selected?.runId).toBe("recovered-attempt");
      expect(settled).toHaveBeenCalledExactlyOnceWith(true);
      expect(getSessionControllerOperation(operation.key)).toBe(operation);
    } finally {
      operation.complete();
    }
  });

  it("does not let a captured old attachment select its owner's recovery backend", async () => {
    const { operation, backend } = createRunningOperation();
    Object.assign(backend, { queueMessage: vi.fn(async () => {}) });
    const captured = captureReplyMessageInjectionTarget(operation);
    expect(captured).toBeDefined();
    expect(canInjectReplyMessageTarget(captured!)).toBe(true);
    try {
      operation.detachBackend(backend);
      operation.attachBackend({
        kind: "embedded",
        runId: "replacement-attachment",
        cancel: vi.fn(),
        queueMessage: vi.fn(async () => {}),
      });
      expect(canInjectReplyMessageTarget(captured!)).toBe(false);
      expect(captureReplyMessageInjectionTarget(operation)?.runId).toBe("replacement-attachment");
    } finally {
      operation.complete();
    }
  });

  it("cancels a recovery readiness waiter without cancelling the logical owner", async () => {
    const { operation, backend } = createRunningOperation();
    const source = new AbortController();
    try {
      operation.detachBackend(backend);
      const readiness = waitForReplyOperationBackend(operation, source.signal);
      source.abort();
      await expect(readiness).rejects.toMatchObject({ name: "AbortError" });
      expect(operation.abortSignal.aborted).toBe(false);
      operation.attachBackend({ kind: "embedded", runId: "retained-recovery", cancel: vi.fn() });
      await expect(waitForReplyOperationBackend(operation)).resolves.toBe(true);
    } finally {
      operation.complete();
    }
  });

  it.each(["Stop", "completion", "finalization", "yield"] as const)(
    "releases a detached recovery waiter on %s without borrowing a successor",
    async (terminal) => {
      const { operation, backend } = createRunningOperation();
      operation.detachBackend(backend);
      const readiness = waitForReplyOperationBackend(operation);
      if (terminal === "Stop") {
        operation.abortByUser();
      } else if (terminal === "finalization") {
        operation.freezeAbort();
      } else if (terminal === "yield") {
        operation.yield();
      } else {
        operation.complete();
      }
      await expect(readiness).resolves.toBe(false);
      operation.complete();
      const successor = createRunningOperation();
      try {
        await expect(waitForReplyOperationBackend(successor.operation)).resolves.toBe(true);
        await expect(readiness).resolves.toBe(false);
      } finally {
        successor.operation.complete();
      }
    },
  );

  it("does not rearm current backend readiness when an old attachment detaches again", async () => {
    const { operation, backend } = createRunningOperation();
    try {
      operation.detachBackend(backend);
      const readiness = waitForReplyOperationBackend(operation);
      operation.attachBackend({ kind: "embedded", runId: "current-recovery", cancel: vi.fn() });
      await expect(readiness).resolves.toBe(true);
      operation.detachBackend(backend);
      await expect(waitForReplyOperationBackend(operation)).resolves.toBe(true);
    } finally {
      operation.complete();
    }
  });

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
      operation.freezeAbort();
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
    expect(getSessionControllerOperation(operation.key)).toBe(operation);
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

  it.each(["replacement", "return"] as const)(
    "keeps retired startup waiters fenced across rekey and %s",
    async (kind) => {
      const operation = createTestReplyOperation();
      const originalKey = operation.key;
      const retired = waitForReplyOperationBackend(operation);
      operation.updateSessionKey("agent:main:rekeyed");
      if (kind === "return") {
        operation.updateSessionKey(originalKey);
      }
      const current = waitForReplyOperationBackend(operation);
      const replacement =
        kind === "replacement" ? createTestReplyOperation({ sessionKey: originalKey }) : undefined;
      if (replacement) {
        replacement.setPhase("running");
        replacement.attachBackend({ kind: "embedded", cancel: vi.fn() });
      }
      await expect(retired).resolves.toBe(false);
      operation.setPhase("running");
      operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
      await expect(current).resolves.toBe(true);
      operation.complete();
      replacement?.complete();
    },
  );

  it("retains physical source settlement after its queued operation moves to another key", async () => {
    const source = captureSessionTarget({
      storeScope: "/stores/rekey-source.sqlite",
      sessionKey: "agent:main:rekey-source",
      incarnation: "source-incarnation",
    });
    const operation = createTestReplyOperation({
      sessionKey: source.sessionKey,
      sessionId: "source-incarnation",
      target: source,
    });
    const effect = await beginSessionEffect({ target: source });
    const held = createDeferred();
    const writing = effect.run(() => held.promise);
    try {
      operation.updateSessionKey("agent:main:rekey-destination");
      const settled = vi.fn();
      const receipt = captureSessionControllerSettlement({ target: source });
      expect(receipt).toBeDefined();
      void receipt?.then(settled);
      expect(() =>
        createTestReplyOperation({
          sessionKey: source.sessionKey,
          sessionId: "next-incarnation",
          target: source,
        }),
      ).toThrow();
      effect.release();
      operation.complete();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      held.resolve();
      await writing;
      await receipt;
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      held.resolve();
      await writing;
      effect.release();
      operation.complete();
    }
  });
});
