import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import {
  testing,
  abortActiveReplyRuns,
  createMaintenanceReplyOperation,
  createReplyOperation,
  forceClearReplyRunBySessionId,
  isReplyRunActiveForSessionId,
  queueReplyRunMessage,
  replyRunRegistry,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
} from "./reply-run-registry.js";

describe("reply run registry", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
  });

  it("keeps ownership stable by sessionKey while sessionId rotates", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-old",
        resetTriggered: false,
      });

      const oldWaitPromise = waitForReplyRunEndBySessionId("session-old", 1_000);

      operation.updateSessionId("session-new");

      expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);
      expect(resolveActiveReplyRunSessionId("agent:main:main")).toBe("session-new");
      expect(isReplyRunActiveForSessionId("session-old")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-new")).toBe(true);

      let settled = false;
      void oldWaitPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      operation.complete();

      await expect(oldWaitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("mirrors active reply operations into diagnostic work state", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:direct:chat-1",
      sessionId: "session-1",
      resetTriggered: false,
    });

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }).activeWorkKind,
    ).toBe("embedded_run");

    operation.updateSessionId("session-2");

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-2",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }).activeWorkKind,
    ).toBe("embedded_run");

    operation.complete();

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-2",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }).activeWorkKind,
    ).toBeUndefined();
  });

  it("clears queued operations immediately on user abort", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-queued",
      resetTriggered: false,
    });

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);

    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("runs completeThen callbacks after active state clears", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-complete",
      resetTriggered: false,
    });
    const afterClear = vi.fn(() => {
      expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-complete")).toBe(false);
    });

    operation.completeThen(afterClear);

    expect(operation.result).toEqual({ kind: "completed" });
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("force-clears a running operation after abort without backend cleanup", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-running",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      operation.setPhase("running");

      operation.abortByUser();
      const waitPromise = waitForReplyRunEndBySessionId("session-running", 1_000);

      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(cancel).toHaveBeenCalledWith("user_abort");
      expect(isReplyRunActiveForSessionId("session-running")).toBe(true);

      expect(forceClearReplyRunBySessionId("session-running", new Error("stuck"))).toBe(true);

      expect(isReplyRunActiveForSessionId("session-running")).toBe(false);
      await expect(waitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("queues messages only through the active running backend", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });

    expect(queueReplyRunMessage("session-running", "before running")).toBe(false);

    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("hello");
  });

  describe("createMaintenanceReplyOperation", () => {
    it("does not register the operation in the active-run registry, so it can coexist with the live reply operation for the same sessionKey", () => {
      const liveOperation = createReplyOperation({
        sessionKey: "agent:main:maint-coexist",
        sessionId: "session-live",
        resetTriggered: false,
      });
      // Without the maintenance distinction, creating a second op for the
      // same sessionKey would throw ReplyRunAlreadyActiveError.
      const maintenanceOperation = createMaintenanceReplyOperation({
        sessionKey: "agent:main:maint-coexist",
        sessionId: "session-live",
      });
      expect(liveOperation).not.toBe(maintenanceOperation);
      expect(isReplyRunActiveForSessionId("session-live")).toBe(true);
      expect(replyRunRegistry.get("agent:main:maint-coexist")).toBe(liveOperation);
      liveOperation.complete();
    });

    it("attachBackend stores the handle (does NOT cancel it) when the maintenance operation has not completed", () => {
      const op = createMaintenanceReplyOperation({
        sessionKey: "agent:main:maint-attach",
        sessionId: "session-maint",
      });
      const cancel = vi.fn();
      const detach = vi.fn();
      op.attachBackend({ cancel, detach } as never);
      expect(cancel).not.toHaveBeenCalled();
    });

    it("attachBackend cancels the handle with 'superseded' if complete() ran first", () => {
      const op = createMaintenanceReplyOperation({
        sessionKey: "agent:main:maint-completed",
        sessionId: "session-maint-completed",
      });
      op.complete();
      const cancel = vi.fn();
      op.attachBackend({ cancel, detach: vi.fn() } as never);
      expect(cancel).toHaveBeenCalledWith("superseded");
    });

    it("propagates upstream abort into the maintenance operation's abortSignal", () => {
      const upstream = new AbortController();
      const op = createMaintenanceReplyOperation({
        sessionKey: "agent:main:maint-abort",
        sessionId: "session-maint-abort",
        upstreamAbortSignal: upstream.signal,
      });
      expect(op.abortSignal.aborted).toBe(false);
      upstream.abort(new Error("user cancelled"));
      expect(op.abortSignal.aborted).toBe(true);
    });

    it("inherits the upstream's already-aborted state at construction time", () => {
      const upstream = new AbortController();
      upstream.abort(new Error("preempt"));
      const op = createMaintenanceReplyOperation({
        sessionKey: "agent:main:maint-pre-abort",
        sessionId: "session-maint-pre-abort",
        upstreamAbortSignal: upstream.signal,
      });
      expect(op.abortSignal.aborted).toBe(true);
    });

    it("complete() detaches the upstream abort listener so it does not survive past terminal state", () => {
      const upstream = new AbortController();
      const addSpy = vi.spyOn(upstream.signal, "addEventListener");
      const removeSpy = vi.spyOn(upstream.signal, "removeEventListener");
      const op = createMaintenanceReplyOperation({
        sessionKey: "agent:main:maint-listener",
        sessionId: "session-maint-listener",
        upstreamAbortSignal: upstream.signal,
      });
      expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
      const addedListener = addSpy.mock.calls[0]?.[1] as EventListener;
      op.complete();
      expect(removeSpy).toHaveBeenCalledWith("abort", addedListener);
      // Aborting upstream after the maintenance op has completed must
      // not flip the maintenance op's signal: it is already complete.
      upstream.abort(new Error("late upstream abort"));
      expect(op.abortSignal.aborted).toBe(false);
    });

    it("fail() also detaches the upstream abort listener", () => {
      const upstream = new AbortController();
      const removeSpy = vi.spyOn(upstream.signal, "removeEventListener");
      const op = createMaintenanceReplyOperation({
        sessionKey: "agent:main:maint-listener-fail",
        sessionId: "session-maint-listener-fail",
        upstreamAbortSignal: upstream.signal,
      });
      op.fail("run_failed", new Error("boom"));
      expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("complete() does not call clearReplyRunState (so it cannot disturb a live reply operation for the same sessionKey)", () => {
      const liveOperation = createReplyOperation({
        sessionKey: "agent:main:maint-complete-isolation",
        sessionId: "session-live-iso",
        resetTriggered: false,
      });
      const maintenanceOperation = createMaintenanceReplyOperation({
        sessionKey: "agent:main:maint-complete-isolation",
        sessionId: "session-live-iso",
      });
      maintenanceOperation.complete();
      // The live reply operation must still be registered as active.
      expect(replyRunRegistry.get("agent:main:maint-complete-isolation")).toBe(liveOperation);
      expect(isReplyRunActiveForSessionId("session-live-iso")).toBe(true);
      liveOperation.complete();
    });
  });

  it("aborts compacting runs through the registry compatibility helper", () => {
    const compactingOperation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-compacting",
      resetTriggered: false,
    });
    compactingOperation.setPhase("preflight_compacting");

    const runningOperation = createReplyOperation({
      sessionKey: "agent:main:other",
      sessionId: "session-running",
      resetTriggered: false,
    });
    runningOperation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "compacting" })).toBe(true);
    expect(compactingOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(runningOperation.result).toBeNull();
  });
});
