import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  abortActiveReplyRuns,
  clearReplyRunForResetBySessionId,
  isReplyRunAbortableForCompaction,
  isReplyRunAbortableForSignal,
  isReplyRunActiveForSessionId,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";

describe("reply run registry cancellation", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
  });

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

  it("clears deferred-maintenance operations immediately on user abort", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-waiting-abort",
    });

    operation.markWaitingForDeferredMaintenance();
    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
    expect(isReplyRunActiveForSessionId("session-waiting-abort")).toBe(false);
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
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:failed-final",
      sessionId: "session-failed-final",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => true,
    });
    operation.setPhase("running");
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

  it("records upstream cancellation as an aborted operation", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:upstream-cancelled",
      sessionId: "session-upstream-cancelled",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    upstreamAbort.abort(new Error("caller cancelled"));

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("user_abort");
    operation.complete();
  });

  it("records upstream restart cancellation separately", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:upstream-restart",
      sessionId: "session-upstream-restart",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    upstreamAbort.abort(createAgentRunRestartAbortError());

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("restart");
    operation.complete();
  });

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

  it("does not cancel the backend twice when upstream abort follows a user abort", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:duplicate-cancel",
      sessionId: "session-duplicate-cancel",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    expect(operation.abortByUser()).toBe(true);
    upstreamAbort.abort(createAgentRunRestartAbortError());

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("user_abort");
    operation.complete();
  });

  it("rejects aborts while the attached backend is finalizing", () => {
    let abortable = false;
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:finalizing",
      sessionId: "session-finalizing",
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => abortable,
    });
    operation.setPhase("running");

    expect(replyRunRegistry.abort("agent:main:finalizing")).toBe(false);
    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    abortable = true;
    expect(replyRunRegistry.abort("agent:main:finalizing")).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledWith("user_abort");
  });

  it("keeps abort frozen after the backend detaches for reply delivery", () => {
    const cancel = vi.fn();
    const upstreamAbort = new AbortController();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:delivery-finalizing",
      sessionId: "session-delivery-finalizing",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    const backend = {
      kind: "embedded" as const,
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    };
    operation.attachBackend(backend);
    operation.setPhase("running");
    operation.freezeAbort();
    operation.detachBackend(backend);

    expect(operation.phase).toBe("running");
    expect(isReplyRunAbortableForSignal(upstreamAbort.signal)).toBe(false);
    expect(isReplyRunAbortableForSignal(new AbortController().signal)).toBe(true);
    expect(replyRunRegistry.abort("agent:main:delivery-finalizing")).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    upstreamAbort.abort();
    expect(operation.abortSignal.aborted).toBe(false);

    operation.complete();
    expect(replyRunRegistry.isActive("agent:main:delivery-finalizing")).toBe(false);
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
