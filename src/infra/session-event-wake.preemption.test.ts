import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  requestSessionEventWake,
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler as setRuntimeSessionEventWakeHandler,
} from "./session-event-wake.js";
import { enqueueSystemEventEntry, peekSystemEventEntries } from "./system-events.js";

describe("session event wake preemption retry", () => {
  type SessionEventWakeHandler = Parameters<typeof setRuntimeSessionEventWakeHandler>[0];
  type WakeRequest = Parameters<typeof requestSessionEventWake>[0];
  let disposeHandler: (() => void) | undefined;

  function setSessionEventWakeHandler(handler: SessionEventWakeHandler) {
    disposeHandler = setRuntimeSessionEventWakeHandler(handler);
  }

  function wake(reason: "manual" | "exec-event", opts: Partial<WakeRequest> = {}) {
    const source = reason === "manual" ? "manual" : "exec-event";
    const intent = reason === "manual" ? "manual" : "event";
    return { source, intent, reason, ...opts } satisfies WakeRequest;
  }

  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    disposeHandler?.();
    const disposeDrain = setRuntimeSessionEventWakeHandler(async () => ({
      status: "skipped",
      reason: "disabled",
    }));
    await vi.runAllTimersAsync();
    disposeDrain();
    disposeHandler = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([-86_400_000, 86_400_000])(
    "dispatches a coalesced wake after the wall clock changes by %i ms",
    async (clockChangeMs) => {
      vi.setSystemTime(2_000_000_000_000);
      const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      setSessionEventWakeHandler(handler);

      requestSessionEventWake(wake("manual", { coalesceMs: 250 }));
      vi.setSystemTime(Date.now() + clockChangeMs);
      await vi.advanceTimersByTimeAsync(249);
      expect(handler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(handler.mock.calls.map(([request]) => request)).toEqual([wake("manual")]);
    },
  );

  it("dispatches an urgent wake after the wall clock changes forward", async () => {
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setSessionEventWakeHandler(handler);

    requestSessionEventWake(wake("exec-event", { agentId: "slow", coalesceMs: 60_000 }));
    vi.setSystemTime(Date.now() + 3_600_000);
    requestSessionEventWake(wake("manual", { agentId: "urgent", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handler.mock.calls.map(([request]) => request)).toEqual([
      wake("manual", { agentId: "urgent" }),
    ]);
  });

  it("retries a retained wake on time after the wall clock changes", async () => {
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "min-spacing",
        retryAtMs: Date.now() + 1_000,
      })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setSessionEventWakeHandler(handler);

    requestSessionEventWake(wake("exec-event", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() - 86_400_000);
    await vi.advanceTimersByTimeAsync(998);
    expect(handler).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("hands a suspended wake to the replacement without running the retired handler", async () => {
    const retiredHandler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const replacementHandler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setSessionEventWakeHandler(retiredHandler);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    const pendingWake = {
      source: "cron" as const,
      intent: "event" as const,
      reason: "cron:retired-generation",
      agentId: "main",
    };
    requestSessionEventWake({ ...pendingWake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    setSessionEventWakeHandler(replacementHandler);
    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);

    expect(retiredHandler).not.toHaveBeenCalled();
    expect(replacementHandler.mock.calls.map(([request]) => request)).toEqual([pendingWake]);
  });

  it.each(["close", "restart"] as const)(
    "retires queued wakes with their system events during full %s",
    async (event) => {
      const sessionKey = "agent:main:main";
      const retired = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const successor = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      setSessionEventWakeHandler(retired);
      try {
        const queued = enqueueSystemEventEntry("retired task completed", { sessionKey });
        expect(queued?.id).toBeTruthy();
        expect(peekSystemEventEntries(sessionKey)).toEqual([queued]);
        requestSessionEventWake({
          source: "background-task",
          intent: "immediate",
          reason: "background-task",
          agentId: "main",
          sessionKey,
          coalesceMs: 250,
        });
        expect(retired).not.toHaveBeenCalled();

        disposeHandler?.();
        await drainGlobalSingletonLifecycleState(event);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        setSessionEventWakeHandler(successor);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(retired).not.toHaveBeenCalled();
        expect(successor).not.toHaveBeenCalled();

        const freshWake = wake("manual", { agentId: "main", sessionKey });
        requestSessionEventWake({ ...freshWake, coalesceMs: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(successor.mock.calls.map(([request]) => request)).toEqual([freshWake]);
      } finally {
        disposeHandler?.();
        await drainGlobalSingletonLifecycleState(event);
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "retires an entire selected batch before a late handler %s",
    async (outcome) => {
      const body = createDeferredCore<{ status: "ran"; durationMs: number }>();
      let closing: Promise<void> | undefined;
      const retired = vi.fn(() => {
        closing = drainGlobalSingletonLifecycleState("close");
        return body.promise;
      });
      const successor = vi.fn(async () => ({ status: "ran" as const, durationMs: 7 }));
      const settled = vi.fn();
      setSessionEventWakeHandler(retired);
      const disposeRetired = disposeHandler;
      const results = ["first", "second", "third"].map((agentId) =>
        requestSessionEventWakeAndWait(wake("exec-event", { agentId, coalesceMs: 0 })).then(
          (result) => {
            settled(result);
            return result;
          },
        ),
      );
      try {
        await vi.advanceTimersByTimeAsync(1);
        expect(closing).toBeDefined();
        await closing;
        expect(retired).toHaveBeenCalledOnce();
        expect(await Promise.all(results)).toEqual(
          Array.from({ length: 3 }, () => ({
            status: "failed",
            reason: "heartbeat wake cancelled",
          })),
        );
        expect(settled).toHaveBeenCalledTimes(3);

        setSessionEventWakeHandler(successor);
        disposeRetired?.();
        const fresh = requestSessionEventWakeAndWait(wake("manual", { coalesceMs: 0 }));
        await vi.advanceTimersByTimeAsync(1);
        await expect(fresh).resolves.toEqual({ status: "ran", durationMs: 7 });
        if (outcome === "resolve") {
          body.resolve({ status: "ran", durationMs: 1 });
        } else {
          body.reject(new Error("retired handler failed late"));
        }
        await Promise.allSettled([body.promise]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(retired).toHaveBeenCalledOnce();
        expect(successor).toHaveBeenCalledOnce();
        expect(settled).toHaveBeenCalledTimes(3);
      } finally {
        body.resolve({ status: "ran", durationMs: 1 });
        await Promise.allSettled([body.promise]);
        await drainGlobalSingletonLifecycleState("close");
      }
    },
  );

  it("cancels selected work parked behind suspended Gateway admission on full close", async () => {
    const retired = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const successor = vi.fn(async () => ({ status: "ran" as const, durationMs: 7 }));
    setSessionEventWakeHandler(retired);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const pending = requestSessionEventWakeAndWait(wake("exec-event", { coalesceMs: 0 }));
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(retired).not.toHaveBeenCalled();
      await drainGlobalSingletonLifecycleState("close");
      await expect(pending).resolves.toEqual({
        status: "failed",
        reason: "heartbeat wake cancelled",
      });
      expect(suspension?.release()).toBe(true);
      setSessionEventWakeHandler(successor);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(retired).not.toHaveBeenCalled();
      expect(successor).not.toHaveBeenCalled();
    } finally {
      suspension?.release();
      await drainGlobalSingletonLifecycleState("close");
    }
  });

  it("joins a reentrant full drain without retiring its abort-listener successor", async () => {
    const oldBody = createDeferredCore<{ status: "ran"; durationMs: number }>();
    const newBody = createDeferredCore<{ status: "ran"; durationMs: number }>();
    let reentrant: Promise<void> | undefined;
    let successorSignal: AbortSignal | undefined;
    const successor = vi.fn((_request: WakeRequest, signal: AbortSignal) => {
      successorSignal = signal;
      return newBody.promise;
    });
    setSessionEventWakeHandler((_request, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          reentrant = drainGlobalSingletonLifecycleState("close");
          setSessionEventWakeHandler(successor);
          requestSessionEventWake(wake("manual", { coalesceMs: 0 }));
        },
        { once: true },
      );
      return oldBody.promise;
    });
    const disposeRetired = disposeHandler;
    const pending = requestSessionEventWakeAndWait(wake("exec-event", { coalesceMs: 0 }));
    try {
      await vi.advanceTimersByTimeAsync(1);
      const first = drainGlobalSingletonLifecycleState("close");
      const concurrent = drainGlobalSingletonLifecycleState("close");
      expect(reentrant).toBeDefined();
      await Promise.all([first, concurrent, reentrant]);
      await expect(pending).resolves.toMatchObject({ status: "failed" });
      disposeRetired?.();
      await vi.advanceTimersByTimeAsync(1);
      expect(successor).toHaveBeenCalledOnce();
      expect(successorSignal?.aborted).toBe(false);
      oldBody.resolve({ status: "ran", durationMs: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(successor).toHaveBeenCalledOnce();
      expect(successorSignal?.aborted).toBe(false);
    } finally {
      oldBody.resolve({ status: "ran", durationMs: 1 });
      newBody.resolve({ status: "ran", durationMs: 7 });
      await Promise.all([oldBody.promise, newBody.promise]);
      await drainGlobalSingletonLifecycleState("close");
    }
  });

  it.each(["active-run", "not-due"])(
    "retires coalesced waiters and the %s retry timer on full restart",
    async (reason) => {
      const retired = vi.fn(async () => ({
        status: "skipped" as const,
        reason,
        retryAtMs: Date.now() + 1_000,
      }));
      const successor = vi.fn(async () => ({ status: "ran" as const, durationMs: 7 }));
      const settled = vi.fn();
      setSessionEventWakeHandler(retired);
      const results = [0, 1].map(() =>
        requestSessionEventWakeAndWait(wake("exec-event", { coalesceMs: 0 })).then(settled),
      );
      try {
        await vi.advanceTimersByTimeAsync(1);
        expect(retired).toHaveBeenCalledOnce();
        expect(settled).not.toHaveBeenCalled();
        await drainGlobalSingletonLifecycleState("restart");
        await Promise.all(results);
        expect(settled).toHaveBeenCalledTimes(2);
        expect(settled).toHaveBeenNthCalledWith(1, {
          status: "failed",
          reason: "heartbeat wake cancelled",
        });
        expect(settled).toHaveBeenNthCalledWith(2, {
          status: "failed",
          reason: "heartbeat wake cancelled",
        });
        setSessionEventWakeHandler(successor);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(retired).toHaveBeenCalledOnce();
        expect(successor).not.toHaveBeenCalled();
        expect(settled).toHaveBeenCalledTimes(2);
      } finally {
        await drainGlobalSingletonLifecycleState("close");
      }
    },
  );

  it.each(
    ["replace", "dispose"].flatMap((change) => [false, true].map((throws) => ({ change, throws }))),
  )(
    "hands an entire ready batch to its next owner after synchronous $change (throws=$throws)",
    async ({ change, throws }) => {
      const replacement = vi.fn(async () => ({ status: "ran" as const, durationMs: 7 }));
      const retired = vi.fn(() => {
        if (retired.mock.calls.length === 1) {
          if (change === "replace") {
            setSessionEventWakeHandler(replacement);
          } else {
            disposeHandler?.();
          }
        }
        if (throws) {
          throw new Error("Retired handler failed synchronously");
        }
        return new Promise<never>(() => {});
      });
      setSessionEventWakeHandler(retired);
      const results = ["first", "second", "third"].map((agentId) =>
        requestSessionEventWakeAndWait(wake("exec-event", { agentId, coalesceMs: 0 })),
      );

      await vi.advanceTimersByTimeAsync(1);
      expect(retired).toHaveBeenCalledOnce();
      if (change === "dispose") {
        expect(replacement).not.toHaveBeenCalled();
        setSessionEventWakeHandler(replacement);
      }
      await vi.runAllTimersAsync();

      expect(replacement).toHaveBeenCalledTimes(3);
      expect(await Promise.all(results)).toEqual([
        { status: "ran", durationMs: 7 },
        { status: "ran", durationMs: 7 },
        { status: "ran", durationMs: 7 },
      ]);
    },
  );

  it("keeps manual requests-in-flight on the default retry delay", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "active-run" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setSessionEventWakeHandler(handler);
    requestSessionEventWake(wake("manual", { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(999);
    expect(handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each(["preempted", "channel-not-ready"])(
    "retries %s event work after idle grace without losing its target",
    async (reason) => {
      const handler = vi
        .fn()
        .mockResolvedValueOnce({ status: "skipped", reason })
        .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
      setSessionEventWakeHandler(handler);
      requestSessionEventWake({
        source: "background-task",
        intent: "event",
        reason: "background-task:job-backup",
        agentId: "main",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });

      await vi.advanceTimersByTimeAsync(59_999);
      expect(handler).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1]?.[0]).toMatchObject({
        sessionKey: "agent:main:main",
        retainedWork: true,
      });
    },
  );

  it("keeps guarded event work retained through preemption", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "not-due",
        retryAtMs: Date.now() + 30_000,
      })
      .mockResolvedValueOnce({ status: "skipped", reason: "preempted" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setSessionEventWakeHandler(handler);
    requestSessionEventWake(wake("exec-event", { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({ retainedWork: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler.mock.calls[2]?.[0]).toMatchObject({ retainedWork: true });
  });
});
