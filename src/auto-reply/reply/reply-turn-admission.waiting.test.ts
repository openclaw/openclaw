import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resetDiagnosticRunActivityForTest,
  RUN_STALE_TAKEOVER_MS,
} from "../../logging/diagnostic-run-activity.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  getSessionControllerOperation,
  runAfterReplyOperationClear,
} from "../../sessions/session-controller.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { SESSION_WATCHDOG_CLEANUP_MS } from "../../sessions/session-controller.watchdog-state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { admitTestReplyTurn } from "./reply-turn-admission.test-support.js";

describe("reply turn admission", () => {
  afterEach(async () => {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
    testing.resetSessionControllerForTest();
    resetDiagnosticRunActivityForTest();
  });

  function attachCompletingBackend(active: ReturnType<typeof createTestReplyOperation>) {
    const cancel = vi.fn();
    active.attachBackend({
      kind: "embedded",
      cancel: (reason) => {
        cancel(reason);
        active.complete();
      },
      isStreaming: () => true,
    });
    active.setPhase("running");
    return cancel;
  }
  function activeReply() {
    return createTestReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
    });
  }
  function observe<T>(pending: Promise<T>) {
    let settled = false;
    return {
      pending: pending.then((result) => {
        settled = true;
        return result;
      }),
      isSettled: () => settled,
    };
  }
  function expectSkipped(
    result: Awaited<ReturnType<typeof admitTestReplyTurn>>,
    active: ReturnType<typeof activeReply>,
    reason = "active-run",
  ) {
    expect(result).toMatchObject({ status: "skipped", reason, activeOperation: active });
  }
  function admitBehind(
    active: ReturnType<typeof createTestReplyOperation>,
    sessionId: string,
    overrides: Partial<Parameters<typeof admitTestReplyTurn>[0]> = {},
  ) {
    return admitTestReplyTurn({ sessionKey: active.key, sessionId, ...overrides });
  }
  function completeOwned(
    result: Awaited<ReturnType<typeof admitTestReplyTurn>>,
    sessionId?: string,
  ) {
    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      if (sessionId) {
        expect(result.operation.sessionId).toBe(sessionId);
      }
      result.operation.complete();
    }
  }

  it.each(["visible", "queued_followup"] as const)("bounds only queued waits: %s", async (kind) => {
    vi.useFakeTimers();
    const active = activeReply();
    active.setPhase("running");
    const admitted = observe(admitBehind(active, "waiting-session", { kind }));
    await vi.advanceTimersByTimeAsync(15_000);
    if (kind === "visible") {
      expect(admitted.isSettled()).toBe(false);
      active.complete();
      completeOwned(await admitted.pending);
    } else {
      expectSkipped(await admitted.pending, active);
      active.complete();
    }
  });

  it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
    const active = activeReply();
    const { promise: barrier, resolve: releaseBarrier } = createDeferred();
    const admitted = observe(admitBehind(active, "queued-session", { kind: "queued_followup" }));

    await Promise.resolve();
    active.completeWithAfterClearBarrier(barrier);
    await Promise.resolve();

    expect(admitted.isSettled()).toBe(false);

    releaseBarrier();
    completeOwned(await admitted.pending);
  });

  it("skips heartbeat turns while delivery settles", async () => {
    const active = activeReply();
    const { promise: barrier, resolve: releaseBarrier } = createDeferred();

    active.completeWithAfterClearBarrier(barrier);
    const result = await admitBehind(active, "heartbeat-session", { kind: "heartbeat" });

    expect(result).toEqual({ status: "skipped", reason: "active-run" });
    releaseBarrier();
    await barrier;
  });

  it("passes a visible turn's rotated session to after-clear work", async () => {
    const active = activeReply();
    const { promise: barrier, resolve: releaseBarrier } = createDeferred();
    let admissionSessionId: string | undefined;
    runAfterReplyOperationClear(active, (sessionId) => {
      admissionSessionId = sessionId;
    });

    active.updateSessionId("rotated-session");
    active.completeWithAfterClearBarrier(barrier);
    expect(admissionSessionId).toBeUndefined();

    releaseBarrier();
    await barrier;
    await vi.waitFor(() => expect(admissionSessionId).toBe("rotated-session"));
    const queuedResult = await admitBehind(active, admissionSessionId ?? "queued-session", {
      kind: "queued_followup",
    });
    completeOwned(queuedResult, "rotated-session");
  });

  it("uses the active run's final session id after waiting", async () => {
    const active = activeReply();
    active.setPhase("preflight_compacting");

    const admitted = admitBehind(active, "new-session");

    await Promise.resolve();
    active.updateSessionId("post-compact-session");
    active.complete();
    completeOwned(await admitted, "post-compact-session");
  });

  it("skips heartbeat turns while a visible turn owns the lane", async () => {
    const active = activeReply();

    const result = await admitBehind(active, "heartbeat-session", { kind: "heartbeat" });

    expectSkipped(result, active);
    active.complete();
  });

  it("lets visible turns reclaim a stale active operation", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const active = activeReply();
    const cancel = attachCompletingBackend(active);
    vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

    const result = await admitBehind(active, "replacement-session");

    expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(active.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("superseded");
    completeOwned(result);
  });

  it("keeps visible turns waiting while an active operation is still fresh", async () => {
    vi.useFakeTimers();
    const active = activeReply();
    active.setPhase("running");
    active.recordActivity();
    const abortController = new AbortController();
    const result = observe(
      admitBehind(active, "waiting-session", {
        upstreamAbortSignal: abortController.signal,
      }),
    );

    await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
    expect(result.isSettled()).toBe(false);
    expect(getSessionControllerOperation(active.key)).toBe(active);

    abortController.abort();
    expectSkipped(await result.pending, active, "aborted");
  });

  it("defers takeover to the blocked-tool floor while a quiet tool is active", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const active = activeReply();
    const cancel = attachCompletingBackend(active);
    const attempt = active.watchdog.attachAttempt({ assertCurrent: () => {} });
    attempt.beginTool({ toolName: "exec", toolCallId: "tool-quiet-1" });

    // 12 minutes of silence with an active tool: past the generic takeover
    // window but inside the blocked-tool floor — must NOT be reclaimed.
    vi.setSystemTime(startedAt + 12 * 60_000);
    const abortController = new AbortController();
    const waiting = observe(
      admitBehind(active, "replacement-quiet-tool", {
        upstreamAbortSignal: abortController.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
    expect(waiting.isSettled()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    // Past the 15-minute floor the same waiting turn reclaims it.
    vi.setSystemTime(startedAt + 16 * 60_000);
    await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
    const result = await waiting.pending;
    expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
    completeOwned(result);
    abortController.abort();
  });

  it.each(["heartbeat", "queued_followup"] as const)(
    "does not let %s turns reclaim a stale active operation",
    async (kind) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const startedAt = Date.now();
      const active = activeReply();
      active.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
      active.setPhase("running");
      vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

      const admission = admitBehind(active, "replacement-session", {
        kind,
        waitTimeoutMs: 1,
      });
      if (kind === "queued_followup") {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      }
      const result = await admission;

      expectSkipped(result, active);
      expect(cancel).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(active.key)).toBe(active);
      active.complete();
    },
  );

  it("keeps terminal raw work owned after cleanup grace until its producer settles", async () => {
    vi.useFakeTimers();
    const active = activeReply();
    active.setPhase("running");
    active.abortByUser();

    const admission = observe(admitBehind(active, "replacement-terminal-session"));
    await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_CLEANUP_MS);
    expect(admission.isSettled()).toBe(false);
    expect(active.terminalProducerBlocked).toBe(true);
    expect(getSessionControllerOperation(active.key)).toBe(active);
    active.complete();
    const result = await admission.pending;

    expect(active.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(getSessionControllerOperation(active.key)).not.toBe(active);
    completeOwned(result);
  });

  it("stops waiting when the caller aborts", async () => {
    const active = activeReply();
    const abortController = new AbortController();
    const admitted = admitBehind(active, "waiting-session", {
      kind: "queued_followup",
      upstreamAbortSignal: abortController.signal,
    });

    abortController.abort();

    expectSkipped(await admitted, active, "aborted");
    active.complete();
  });
});
