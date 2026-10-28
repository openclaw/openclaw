import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let active: ReturnType<typeof createTestReplyOperation>;
  beforeEach(() => {
    vi.useFakeTimers();
    active = createTestReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
    });
  });
  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    testing.resetSessionControllerForTest();
    resetDiagnosticRunActivityForTest();
  });

  function attachCompletingBackend() {
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
    reason = "active-run",
  ) {
    expect(result).toMatchObject({ status: "skipped", reason, activeOperation: active });
  }
  function admitBehind(
    sessionId: string,
    overrides: Partial<Parameters<typeof admitTestReplyTurn>[0]> = {},
  ) {
    return admitTestReplyTurn({ sessionKey: active.key, sessionId, ...overrides });
  }
  function abortableWait(kind: "visible" | "queued_followup" = "visible") {
    const controller = new AbortController();
    return {
      ...observe(admitBehind("waiting-session", { kind, upstreamAbortSignal: controller.signal })),
      abort: () => controller.abort(),
    };
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
    active.setPhase("running");
    const admitted = observe(admitBehind("waiting-session", { kind }));
    await vi.advanceTimersByTimeAsync(15_000);
    if (kind === "visible") {
      expect(admitted.isSettled()).toBe(false);
      active.complete();
      completeOwned(await admitted.pending);
    } else {
      expectSkipped(await admitted.pending);
      active.complete();
    }
  });

  it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
    const { promise: barrier, resolve: releaseBarrier } = createDeferred();
    const admitted = observe(admitBehind("queued-session", { kind: "queued_followup" }));

    await Promise.resolve();
    active.completeWithAfterClearBarrier(barrier);
    await Promise.resolve();

    expect(admitted.isSettled()).toBe(false);

    releaseBarrier();
    completeOwned(await admitted.pending);
  });

  it("passes a visible turn's rotated session to after-clear work", async () => {
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
    const queuedResult = await admitBehind(admissionSessionId ?? "queued-session", {
      kind: "queued_followup",
    });
    completeOwned(queuedResult, "rotated-session");
  });

  it("uses the active run's final session id after waiting", async () => {
    active.setPhase("preflight_compacting");

    const admitted = admitBehind("new-session");

    await Promise.resolve();
    active.updateSessionId("post-compact-session");
    active.complete();
    completeOwned(await admitted, "post-compact-session");
  });

  it("lets visible turns reclaim a stale active operation", async () => {
    const startedAt = Date.now();
    const cancel = attachCompletingBackend();
    vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

    const result = await admitBehind("replacement-session");

    expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(active.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("superseded");
    completeOwned(result);
  });

  it.each([
    ["visible", REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS],
    ["queued_followup", 0],
  ] as const)("keeps %s waiting until its caller aborts", async (kind, elapsed) => {
    active.setPhase("running");
    active.recordActivity();
    const result = abortableWait(kind);

    if (elapsed) {
      await vi.advanceTimersByTimeAsync(elapsed);
    }
    expect(result.isSettled()).toBe(false);
    expect(getSessionControllerOperation(active.key)).toBe(active);

    result.abort();
    expectSkipped(await result.pending, "aborted");
    active.complete();
  });

  it("defers takeover to the blocked-tool floor while a quiet tool is active", async () => {
    const startedAt = Date.now();
    const cancel = attachCompletingBackend();
    const attempt = active.watchdog.attachAttempt({ assertCurrent: () => {} });
    attempt.beginTool({ toolName: "exec", toolCallId: "tool-quiet-1" });

    // Silence past generic takeover but inside the blocked-tool floor.
    vi.setSystemTime(startedAt + 12 * 60_000);
    const waiting = abortableWait();
    await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
    expect(waiting.isSettled()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    // Past the 15-minute floor the same waiting turn reclaims it.
    vi.setSystemTime(startedAt + 16 * 60_000);
    await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
    const result = await waiting.pending;
    expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
    completeOwned(result);
    waiting.abort();
  });

  it("does not let queued followups reclaim a stale active operation", async () => {
    const cancel = vi.fn();
    const startedAt = Date.now();
    active.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
    active.setPhase("running");
    vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

    const admission = admitBehind("replacement-session", {
      kind: "queued_followup",
      waitTimeoutMs: 1,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    const result = await admission;

    expectSkipped(result);
    expect(cancel).not.toHaveBeenCalled();
    expect(getSessionControllerOperation(active.key)).toBe(active);
    active.complete();
  });

  it("keeps terminal raw work owned after cleanup grace until its producer settles", async () => {
    active.setPhase("running");
    active.abortByUser();

    const admission = observe(admitBehind("replacement-terminal-session"));
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
});
