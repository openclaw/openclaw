import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  SESSION_EVENT_IDLE_RETRY_MS,
  deferSessionEventWakePoll,
  getSessionEventWakeAbortSignal,
  isSessionEventWakePollDeferred,
  markSessionEventWakeWorkStarted,
  requestSessionEventWake,
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler as setRuntimeSessionEventWakeHandler,
} from "./session-event-wake.js";

describe("session event wake disposition and preemption", () => {
  type WakeRequest = Parameters<typeof requestSessionEventWakeAndWait>[0];
  type WakeHandler = NonNullable<Parameters<typeof setRuntimeSessionEventWakeHandler>[0]>;
  const cadenceMs = 5 * 60_000;
  const terminalFailure = { status: "failed" as const, reason: "test-terminal-failure" };
  let disposeHandler: (() => void) | undefined;

  function setSessionEventWakeHandler(handler: WakeHandler): void {
    disposeHandler = setRuntimeSessionEventWakeHandler(handler);
  }

  function wake(reason: "manual" | "exec-event", opts: Partial<WakeRequest> = {}) {
    const source = reason === "manual" ? "manual" : "exec-event";
    const intent = reason === "manual" ? "manual" : "event";
    return { source, intent, reason, ...opts } satisfies WakeRequest;
  }

  function nativePoll(overrides: Partial<WakeRequest> = {}): WakeRequest {
    return {
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      sessionKey: "agent:main:main",
      scheduledEveryMs: cadenceMs,
      coalesceMs: 0,
      ...overrides,
    };
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

  it("keeps private dispositions and started work separate across concurrent targets", async () => {
    expect(getSessionEventWakeAbortSignal()).toBeUndefined();
    expect(deferSessionEventWakePoll()).toBe(false);
    expect(isSessionEventWakePollDeferred()).toBe(false);
    expect(() => markSessionEventWakeWorkStarted()).not.toThrow();
    const bothStarted = createDeferred();
    const pollDeferred = createDeferred();
    let starts = 0;
    const skipped = { status: "skipped" as const, reason: "requests-in-flight" };
    const handler = vi.fn<WakeHandler>(async (request, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(getSessionEventWakeAbortSignal()).toBe(signal);
      const admitted = request.agentId === "admitted";
      if (admitted) {
        markSessionEventWakeWorkStarted();
      }
      if (++starts === 2) {
        bothStarted.resolve();
      }
      await bothStarted.promise;
      expect(getSessionEventWakeAbortSignal()).toBe(signal);
      if (!admitted) {
        expect(deferSessionEventWakePoll()).toBe(true);
        expect(isSessionEventWakePollDeferred()).toBe(true);
        pollDeferred.resolve();
        return skipped;
      }
      await pollDeferred.promise;
      expect(isSessionEventWakePollDeferred()).toBe(false);
      expect(deferSessionEventWakePoll()).toBe(false);
      expect(getSessionEventWakeAbortSignal()).toBe(signal);
      return terminalFailure;
    });
    setSessionEventWakeHandler(handler);
    const poll = requestSessionEventWakeAndWait(
      nativePoll({ agentId: "poll", sessionKey: "agent:poll:main", tasks: [] }),
    );
    const admitted = requestSessionEventWakeAndWait(
      nativePoll({ agentId: "admitted", sessionKey: "agent:admitted:main" }),
    );
    await vi.advanceTimersByTimeAsync(1);
    await expect(poll).resolves.toBe(skipped);
    await expect(admitted).resolves.toBe(terminalFailure);
    await vi.advanceTimersByTimeAsync(601_000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(getSessionEventWakeAbortSignal()).toBeUndefined();
    expect(isSessionEventWakePollDeferred()).toBe(false);
  });

  const task = { jobId: "job-inbox", name: "inbox", prompt: "Check inbox" };
  const ineligibleCases: Array<[string, Partial<WakeRequest>, "native-first"?, number?]> = [
    [
      "global alias",
      { agentId: undefined, sessionKey: "global" },
      undefined,
      SESSION_EVENT_IDLE_RETRY_MS,
    ],
    ["missing cadence", { scheduledEveryMs: undefined }, "native-first"],
    ["event", { source: "exec-event", intent: "event" }, "native-first"],
    ["immediate interval", { intent: "immediate" }, "native-first"],
    ["task turn", { intent: "task", tasks: [task] }, "native-first"],
  ];

  it.each(ineligibleCases)(
    "never grants poll eligibility to %s (case %#)",
    async (name, overrides, order, retryMs = 1_000) => {
      const dispositions: boolean[][] = [];
      const handler = vi.fn<WakeHandler>(async () => {
        dispositions.push([
          isSessionEventWakePollDeferred(),
          deferSessionEventWakePoll(),
          isSessionEventWakePollDeferred(),
        ]);
        return dispositions.length === 1
          ? {
              status: "skipped",
              reason:
                retryMs === SESSION_EVENT_IDLE_RETRY_MS ? "requests-in-flight" : "cron-in-progress",
            }
          : terminalFailure;
      });
      setSessionEventWakeHandler(handler);
      const invalid = nativePoll({ ...overrides, coalesceMs: 100 });
      const valid = nativePoll({ coalesceMs: 100 });
      const requests = order === undefined ? [invalid] : [valid, invalid];
      const settled = vi.fn();
      const results = requests.map((request) => {
        const result = requestSessionEventWakeAndWait(request);
        void result.then(settled);
        return result;
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledOnce();
      expect(dispositions).toEqual([[false, false, false]]);
      expect(settled).not.toHaveBeenCalled();
      if (name === "missing cadence" && order !== undefined) {
        // The merged public request looks native; eligibility must retain both admissions.
        expect(handler.mock.calls[0]?.[0]).toMatchObject({
          source: "interval",
          intent: "scheduled",
          scheduledEveryMs: cadenceMs,
        });
      }

      await vi.advanceTimersByTimeAsync(retryMs);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(dispositions).toEqual([
        [false, false, false],
        [false, false, false],
      ]);
      expect(settled).toHaveBeenCalledTimes(results.length);
      expect(await Promise.all(results)).toEqual(results.map(() => terminalFailure));
      for (const result of results) {
        expect(await result).toBe(terminalFailure);
      }
    },
  );

  it.each(["preempted", "channel-not-ready"])(
    "preserves started work through %s retry and handler replacement",
    async (reason) => {
      const target = { agentId: "retry-owner", sessionKey: "agent:retry-owner:background" };
      const oldHandler = vi.fn<WakeHandler>(async () => {
        markSessionEventWakeWorkStarted();
        return { status: "skipped", reason };
      });
      setSessionEventWakeHandler(oldHandler);
      const settled = vi.fn();
      const result = requestSessionEventWakeAndWait(nativePoll(target));
      void result.then(settled);

      await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS - 1);
      expect(oldHandler).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(oldHandler).toHaveBeenCalledTimes(2);
      expect(oldHandler.mock.calls[1]?.[0]).toMatchObject({ ...target, retainedWork: true });
      expect(settled).not.toHaveBeenCalled();

      const dispositions: boolean[][] = [];
      const replacement = vi.fn<WakeHandler>(async () => {
        dispositions.push([
          isSessionEventWakePollDeferred(),
          deferSessionEventWakePoll(),
          isSessionEventWakePollDeferred(),
        ]);
        return dispositions.length === 1
          ? { status: "skipped", reason: "requests-in-flight" }
          : terminalFailure;
      });
      setSessionEventWakeHandler(replacement);
      await vi.advanceTimersByTimeAsync(250);

      expect(replacement).toHaveBeenCalledOnce();
      expect(replacement.mock.calls[0]?.[0]).toMatchObject(target);
      expect(replacement.mock.calls[0]?.[0].retainedWork).toBeUndefined();
      expect(dispositions).toEqual([[false, false, false]]);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS);
      expect(replacement).toHaveBeenCalledTimes(2);
      expect(replacement.mock.calls[1]?.[0]).toMatchObject({ ...target, retainedWork: true });
      expect(dispositions).toEqual([
        [false, false, false],
        [false, false, false],
      ]);
      expect(settled).toHaveBeenCalledExactlyOnceWith(terminalFailure);
      expect(await result).toBe(terminalFailure);
    },
  );

  it.each(["while-active", "after-retained"])(
    "keeps started work sticky when a later native poll joins %s",
    async (enqueueAt) => {
      const finishFirst = createDeferred();
      const dispositions: boolean[] = [];
      const handler = vi.fn<WakeHandler>(async () => {
        if (handler.mock.calls.length === 1) {
          markSessionEventWakeWorkStarted();
          await finishFirst.promise;
          return { status: "skipped", reason: "preempted" };
        }
        dispositions.push(deferSessionEventWakePoll());
        return dispositions.length === 1
          ? { status: "skipped", reason: "cron-in-progress" }
          : terminalFailure;
      });
      setSessionEventWakeHandler(handler);
      const settled = vi.fn();
      const original = requestSessionEventWakeAndWait(nativePoll());
      void original.then(settled);
      const laterRequest = nativePoll({ scheduledEveryMs: 2 * cadenceMs });
      let later: ReturnType<typeof requestSessionEventWakeAndWait>;

      try {
        await vi.advanceTimersByTimeAsync(1);
        expect(handler).toHaveBeenCalledOnce();
        if (enqueueAt === "while-active") {
          later = requestSessionEventWakeAndWait(laterRequest);
          finishFirst.resolve();
          await vi.advanceTimersByTimeAsync(0);
        } else {
          finishFirst.resolve();
          await vi.advanceTimersByTimeAsync(0);
          later = requestSessionEventWakeAndWait(laterRequest);
        }
        void later.then(settled);

        await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(handler.mock.calls[1]?.[0].scheduledEveryMs).toBe(2 * cadenceMs);
        expect(dispositions).toEqual([false]);
        expect(settled).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(handler).toHaveBeenCalledTimes(3);
        expect(dispositions).toEqual([false, false]);
        expect(settled).toHaveBeenCalledTimes(2);
        expect(await Promise.all([original, later])).toEqual([terminalFailure, terminalFailure]);
      } finally {
        finishFirst.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it("revokes a tentative poll disposition when work starts in the same attempt", async () => {
    const dispositions: boolean[] = [];
    const handler = vi.fn<WakeHandler>(async () => {
      if (handler.mock.calls.length === 1) {
        dispositions.push(deferSessionEventWakePoll());
        markSessionEventWakeWorkStarted();
        dispositions.push(isSessionEventWakePollDeferred(), deferSessionEventWakePoll());
        return { status: "skipped", reason: "active-run" };
      }
      dispositions.push(deferSessionEventWakePoll());
      return terminalFailure;
    });
    setSessionEventWakeHandler(handler);
    const settled = vi.fn();
    const result = requestSessionEventWakeAndWait(nativePoll());
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(1);
    expect(dispositions).toEqual([true, false, false]);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(dispositions).toEqual([true, false, false, false]);
    expect(settled).toHaveBeenCalledExactlyOnceWith(terminalFailure);
    expect(await result).toBe(terminalFailure);
  });

  it("does not carry a tentative poll disposition across a thrown attempt", async () => {
    const dispositions: boolean[] = [];
    const handler = vi.fn<WakeHandler>(async (): ReturnType<WakeHandler> => {
      dispositions.push(isSessionEventWakePollDeferred());
      if (handler.mock.calls.length === 1) {
        dispositions.push(deferSessionEventWakePoll());
        throw new Error("test-attempt-interrupted");
      }
      return handler.mock.calls.length === 2
        ? { status: "skipped", reason: "cron-in-progress" }
        : terminalFailure;
    });
    setSessionEventWakeHandler(handler);
    const settled = vi.fn();
    const result = requestSessionEventWakeAndWait(nativePoll());
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(dispositions).toEqual([false, true, false]);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(dispositions).toEqual([false, true, false, false]);
    expect(settled).toHaveBeenCalledExactlyOnceWith(terminalFailure);
    expect(await result).toBe(terminalFailure);
  });

  it("cancels only the exact waiter without aborting its coalesced native poll", async () => {
    const finish = createDeferred();
    const waiterAbort = new AbortController();
    const skipped = { status: "skipped" as const, reason: "requests-in-flight" };
    const dispositions: boolean[] = [];
    const handler = vi.fn<WakeHandler>(async () => {
      await finish.promise;
      dispositions.push(deferSessionEventWakePoll());
      return skipped;
    });
    setSessionEventWakeHandler(handler);
    const cancelled = vi.fn();
    const surviving = vi.fn();
    const first = requestSessionEventWakeAndWait(nativePoll({ coalesceMs: 100 }), {
      abortSignal: waiterAbort.signal,
    });
    const second = requestSessionEventWakeAndWait(nativePoll({ coalesceMs: 100 }));
    void first.then(cancelled);
    void second.then(surviving);

    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledOnce();
      const ownerSignal = handler.mock.calls[0]?.[1];
      expect(ownerSignal).not.toBe(waiterAbort.signal);
      expect(ownerSignal?.aborted).toBe(false);

      waiterAbort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelled).toHaveBeenCalledExactlyOnceWith({
        status: "failed",
        reason: "heartbeat wake cancelled",
      });
      expect(ownerSignal?.aborted).toBe(false);
      expect(surviving).not.toHaveBeenCalled();

      finish.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(dispositions).toEqual([true]);
      expect(surviving).toHaveBeenCalledExactlyOnceWith(skipped);
      expect(await second).toBe(skipped);
      expect(await first).toEqual({ status: "failed", reason: "heartbeat wake cancelled" });

      await vi.advanceTimersByTimeAsync(601_000);
      expect(handler).toHaveBeenCalledOnce();
      expect(cancelled).toHaveBeenCalledOnce();
      expect(surviving).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
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
