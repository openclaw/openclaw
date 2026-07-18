// Tests reply turn admission decisions for active, queued, and aborted runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markDiagnosticToolStartedForTest,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import {
  createReplyOperation,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  REPLY_RUN_STALE_TAKEOVER_MS,
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  runAfterReplyOperationClear,
  testing,
} from "./reply-run-registry.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

describe("reply turn admission", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
  });

  it("waits for visible turns and reuses the active session id", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    active.setPhase("running");

    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "new-session",
      kind: "visible",
      resetTriggered: false,
    });

    let settled = false;
    void admitted.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe("active-session");
      result.operation.complete();
    }
  });

  it("does not apply cleanup settle timeout to visible turn admission", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
        resetTriggered: false,
      });
      active.setPhase("running");

      const admitted = admitReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "waiting-session",
        kind: "visible",
        resetTriggered: false,
      });

      let settled = false;
      void admitted.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);

      active.complete();
      const result = await admitted;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps the cleanup settle timeout for queued follow-up retry", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
        resetTriggered: false,
      });
      active.setPhase("running");

      const admitted = admitReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "queued-session",
        kind: "queued_followup",
        resetTriggered: false,
      });

      await vi.advanceTimersByTimeAsync(15_000);

      await expect(admitted).resolves.toMatchObject({
        status: "skipped",
        reason: "active-run",
        activeOperation: active,
      });
      active.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const admitted = admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "queued-session",
      kind: "queued_followup",
      resetTriggered: false,
    });
    let settled = false;
    void admitted.then(() => {
      settled = true;
    });

    await Promise.resolve();
    active.completeWithAfterClearBarrier(barrier);
    await Promise.resolve();

    expect(settled).toBe(false);

    releaseBarrier();
    const result = await admitted;
    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      result.operation.complete();
    }
  });

  it("allows a visible turn to claim the lane while delivery settles", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    active.completeWithAfterClearBarrier(barrier);
    const result = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "visible-session",
      kind: "visible",
      resetTriggered: false,
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      result.operation.complete();
    }
    releaseBarrier();
    await barrier;
  });

  it("skips heartbeat turns while delivery settles", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    active.completeWithAfterClearBarrier(barrier);
    const result = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "heartbeat-session",
      kind: "heartbeat",
      resetTriggered: false,
    });

    expect(result).toEqual({ status: "skipped", reason: "active-run" });
    releaseBarrier();
    await barrier;
  });

  it("passes a visible turn's rotated session to after-clear work", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let admissionSessionId: string | undefined;
    runAfterReplyOperationClear(active, (sessionId) => {
      admissionSessionId = sessionId;
    });

    active.completeWithAfterClearBarrier(barrier);
    const visibleAdmission = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "visible-session",
      kind: "visible",
      resetTriggered: false,
    });
    expect(visibleAdmission.status).toBe("owned");
    if (visibleAdmission.status === "owned") {
      visibleAdmission.operation.updateSessionId("rotated-session");
      visibleAdmission.operation.complete();
    }

    releaseBarrier();
    await barrier;
    await vi.waitFor(() => {
      expect(admissionSessionId).toBe("rotated-session");
    });
    const queuedResult = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: admissionSessionId ?? "queued-session",
      kind: "queued_followup",
      resetTriggered: false,
    });
    expect(queuedResult.status).toBe("owned");
    if (queuedResult.status === "owned") {
      expect(queuedResult.operation.sessionId).toBe("rotated-session");
      queuedResult.operation.complete();
    }
  });

  it("uses the active run's final session id after waiting", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "pre-compact-session",
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");

    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "new-session",
      kind: "visible",
      resetTriggered: false,
    });

    await Promise.resolve();
    active.updateSessionId("post-compact-session");
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe("post-compact-session");
      result.operation.complete();
    }
  });

  it("skips heartbeat turns while a visible turn owns the lane", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "visible-session",
      resetTriggered: false,
    });

    const result = await admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "heartbeat-session",
      kind: "heartbeat",
      resetTriggered: false,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "active-run",
      activeOperation: active,
    });
    active.complete();
  });

  it("lets visible turns reclaim a stale active operation", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const startedAt = Date.now();
      const active = createReplyOperation({
        sessionKey: "agent:main:telegram:topic:stale-visible",
        sessionId: "stale-session",
        resetTriggered: false,
      });
      active.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      active.setPhase("running");
      vi.setSystemTime(startedAt + REPLY_RUN_STALE_TAKEOVER_MS + 1);

      const result = await admitReplyTurn({
        sessionKey: "agent:main:telegram:topic:stale-visible",
        sessionId: "replacement-session",
        kind: "visible",
        resetTriggered: false,
      });

      expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(active.abortSignal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledWith("superseded");
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps visible turns waiting while an active operation is still fresh", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:telegram:topic:fresh-visible",
        sessionId: "fresh-session",
        resetTriggered: false,
      });
      active.setPhase("running");
      active.recordActivity();
      const abortController = new AbortController();
      let settled = false;
      const result = admitReplyTurn({
        sessionKey: "agent:main:telegram:topic:fresh-visible",
        sessionId: "waiting-session",
        kind: "visible",
        resetTriggered: false,
        upstreamAbortSignal: abortController.signal,
      }).then((admission) => {
        settled = true;
        return admission;
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(settled).toBe(false);
      expect(replyRunRegistry.get("agent:main:telegram:topic:fresh-visible")).toBe(active);

      abortController.abort();
      await expect(result).resolves.toMatchObject({
        status: "skipped",
        reason: "aborted",
        activeOperation: active,
      });
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("defers takeover to the blocked-tool floor while a quiet tool is active", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const startedAt = Date.now();
      const active = createReplyOperation({
        sessionKey: "agent:main:telegram:topic:quiet-tool",
        sessionId: "quiet-tool-session",
        resetTriggered: false,
      });
      active.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      active.setPhase("running");
      markDiagnosticToolStartedForTest({
        sessionId: "quiet-tool-session",
        sessionKey: "agent:main:telegram:topic:quiet-tool",
        toolName: "exec",
        toolCallId: "tool-quiet-1",
      });

      vi.setSystemTime(startedAt + 12 * 60_000);
      let settled = false;
      const waiting = admitReplyTurn({
        sessionKey: "agent:main:telegram:topic:quiet-tool",
        sessionId: "replacement-quiet-tool",
        kind: "visible",
        resetTriggered: false,
      }).then((admission) => {
        settled = true;
        return admission;
      });
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(settled).toBe(false);
      expect(cancel).not.toHaveBeenCalled();

      vi.setSystemTime(startedAt + 16 * 60_000);
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      const result = await waiting;
      expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it.each(["heartbeat", "queued_followup"] as const)(
    "does not let %s turns reclaim a stale active operation",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const cancel = vi.fn();
        const startedAt = Date.now();
        const active = createReplyOperation({
          sessionKey: `agent:main:telegram:topic:stale-${kind}`,
          sessionId: `stale-${kind}-session`,
          resetTriggered: false,
        });
        active.attachBackend({
          kind: "embedded",
          cancel,
          isStreaming: () => true,
        });
        active.setPhase("running");
        vi.setSystemTime(startedAt + REPLY_RUN_STALE_TAKEOVER_MS + 1);

        const admission = admitReplyTurn({
          sessionKey: `agent:main:telegram:topic:stale-${kind}`,
          sessionId: `replacement-${kind}-session`,
          kind,
          resetTriggered: false,
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
        expect(replyRunRegistry.get(`agent:main:telegram:topic:stale-${kind}`)).toBe(active);
        active.complete();
      } finally {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    },
  );

  it("lets visible turns reclaim terminal operations after settle grace elapsed", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const active = createReplyOperation({
        sessionKey: "agent:main:telegram:topic:terminal-unreleased",
        sessionId: "terminal-unreleased-session",
        resetTriggered: false,
      });
      active.setPhase("running");
      active.abortByUser();
      vi.setSystemTime(startedAt + REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);

      const result = await admitReplyTurn({
        sessionKey: "agent:main:telegram:topic:terminal-unreleased",
        sessionId: "replacement-terminal-session",
        kind: "visible",
        resetTriggered: false,
      });

      expect(active.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(replyRunRegistry.get("agent:main:telegram:topic:terminal-unreleased")).not.toBe(
        active,
      );
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("stops waiting when the caller aborts", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    const abortController = new AbortController();
    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "waiting-session",
      kind: "queued_followup",
      resetTriggered: false,
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
