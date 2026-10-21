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
  function activeReply(sessionKey: string, sessionId: string) {
    return createTestReplyOperation({ sessionKey, sessionId });
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
    const active = activeReply("agent:main:discord:channel:42", "active-session");
    active.setPhase("running");
    const admitted = admitBehind(
      active,
      kind === "visible" ? "waiting-session" : "queued-session",
      {
        kind,
      },
    );
    let settled = false;
    void admitted.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    if (kind === "visible") {
      expect(settled).toBe(false);
      active.complete();
      completeOwned(await admitted);
    } else {
      await expect(admitted).resolves.toMatchObject({
        status: "skipped",
        reason: "active-run",
        activeOperation: active,
      });
      active.complete();
    }
  });

  it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
    const active = activeReply("agent:main:discord:channel:42", "active-session");
    const { promise: barrier, resolve: releaseBarrier } = createDeferred();
    const admitted = admitBehind(active, "queued-session", { kind: "queued_followup" });
    let settled = false;
    void admitted.then(() => {
      settled = true;
    });

    await Promise.resolve();
    active.completeWithAfterClearBarrier(barrier);
    await Promise.resolve();

    expect(settled).toBe(false);

    releaseBarrier();
    completeOwned(await admitted);
  });

  it("skips heartbeat turns while delivery settles", async () => {
    const active = activeReply("agent:main:discord:channel:42", "active-session");
    const { promise: barrier, resolve: releaseBarrier } = createDeferred();

    active.completeWithAfterClearBarrier(barrier);
    const result = await admitBehind(active, "heartbeat-session", { kind: "heartbeat" });

    expect(result).toEqual({ status: "skipped", reason: "active-run" });
    releaseBarrier();
    await barrier;
  });

  it("passes a visible turn's rotated session to after-clear work", async () => {
    const active = activeReply("agent:main:discord:channel:42", "active-session");
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
    const active = activeReply("agent:main:telegram:topic:42", "pre-compact-session");
    active.setPhase("preflight_compacting");

    const admitted = admitBehind(active, "new-session");

    await Promise.resolve();
    active.updateSessionId("post-compact-session");
    active.complete();
    completeOwned(await admitted, "post-compact-session");
  });

  it("skips heartbeat turns while a visible turn owns the lane", async () => {
    const active = activeReply("agent:main:telegram:topic:42", "visible-session");

    const result = await admitBehind(active, "heartbeat-session", { kind: "heartbeat" });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "active-run",
      activeOperation: active,
    });
    active.complete();
  });

  it("lets visible turns reclaim a stale active operation", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const active = activeReply("agent:main:telegram:topic:stale-visible", "stale-session");
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
    const active = activeReply("agent:main:telegram:topic:fresh-visible", "fresh-session");
    active.setPhase("running");
    active.recordActivity();
    const abortController = new AbortController();
    let settled = false;
    const result = admitBehind(active, "waiting-session", {
      upstreamAbortSignal: abortController.signal,
    }).then((admission) => {
      settled = true;
      return admission;
    });

    await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(getSessionControllerOperation("agent:main:telegram:topic:fresh-visible")).toBe(active);

    abortController.abort();
    await expect(result).resolves.toMatchObject({
      status: "skipped",
      reason: "aborted",
      activeOperation: active,
    });
  });

  it("defers takeover to the blocked-tool floor while a quiet tool is active", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const active = activeReply("agent:main:telegram:topic:quiet-tool", "quiet-tool-session");
    const cancel = attachCompletingBackend(active);
    const attempt = active.watchdog.attachAttempt({ assertCurrent: () => {} });
    attempt.beginTool({ toolName: "exec", toolCallId: "tool-quiet-1" });

    // 12 minutes of silence with an active tool: past the generic takeover
    // window but inside the blocked-tool floor — must NOT be reclaimed.
    vi.setSystemTime(startedAt + 12 * 60_000);
    const abortController = new AbortController();
    let settled = false;
    const waiting = admitBehind(active, "replacement-quiet-tool", {
      upstreamAbortSignal: abortController.signal,
    }).then((admission) => {
      settled = true;
      return admission;
    });
    await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    // Past the 15-minute floor the same waiting turn reclaims it.
    vi.setSystemTime(startedAt + 16 * 60_000);
    await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
    const result = await waiting;
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
      const active = activeReply(
        `agent:main:telegram:topic:stale-${kind}`,
        `stale-${kind}-session`,
      );
      active.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
      active.setPhase("running");
      vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

      const admission = admitTestReplyTurn({
        sessionKey: `agent:main:telegram:topic:stale-${kind}`,
        sessionId: `replacement-${kind}-session`,
        kind,
        waitTimeoutMs: 1,
      });
      if (kind === "queued_followup") {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      }
      const result = await admission;

      expect(result).toMatchObject({
        status: "skipped",
        reason: "active-run",
        activeOperation: active,
      });
      expect(cancel).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(`agent:main:telegram:topic:stale-${kind}`)).toBe(active);
      active.complete();
    },
  );

  it("keeps terminal raw work owned after cleanup grace until its producer settles", async () => {
    vi.useFakeTimers();
    const active = activeReply(
      "agent:main:telegram:topic:terminal-unreleased",
      "terminal-unreleased-session",
    );
    active.setPhase("running");
    active.abortByUser();

    const admission = admitBehind(active, "replacement-terminal-session");
    let admitted = false;
    void admission.then(() => {
      admitted = true;
    });
    await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_CLEANUP_MS);
    expect(admitted).toBe(false);
    expect(active.terminalProducerBlocked).toBe(true);
    expect(getSessionControllerOperation("agent:main:telegram:topic:terminal-unreleased")).toBe(
      active,
    );
    active.complete();
    const result = await admission;

    expect(active.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(getSessionControllerOperation("agent:main:telegram:topic:terminal-unreleased")).not.toBe(
      active,
    );
    completeOwned(result);
  });

  it("stops waiting when the caller aborts", async () => {
    const active = activeReply("agent:main:telegram:topic:42", "active-session");
    const abortController = new AbortController();
    const admitted = admitBehind(active, "waiting-session", {
      kind: "queued_followup",
      upstreamAbortSignal: abortController.signal,
    });

    abortController.abort();

    await expect(admitted).resolves.toMatchObject({
      status: "skipped",
      reason: "aborted",
      activeOperation: active,
    });
    active.complete();
  });
});
