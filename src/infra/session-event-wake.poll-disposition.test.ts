import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  SESSION_EVENT_IDLE_RETRY_MS,
  deferSessionEventWakePoll,
  getSessionEventWakeAbortSignal,
  isSessionEventWakePollDeferred,
  markSessionEventWakeWorkStarted,
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler as setRuntimeSessionEventWakeHandler,
} from "./session-event-wake.js";

describe("session event wake private poll disposition", () => {
  type WakeRequest = Parameters<typeof requestSessionEventWakeAndWait>[0];
  type WakeHandler = NonNullable<Parameters<typeof setRuntimeSessionEventWakeHandler>[0]>;
  const cadenceMs = 5 * 60_000;
  const terminalFailure = { status: "failed" as const, reason: "test-terminal-failure" };
  let disposeHandler: (() => void) | undefined;

  function setSessionEventWakeHandler(handler: WakeHandler): void {
    disposeHandler = setRuntimeSessionEventWakeHandler(handler);
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

  it.each([
    { reason: "requests-in-flight", defer: true, retryMs: SESSION_EVENT_IDLE_RETRY_MS },
    { reason: "active-run", defer: false, retryMs: SESSION_EVENT_IDLE_RETRY_MS },
    { reason: "requests-in-flight", defer: false, retryMs: SESSION_EVENT_IDLE_RETRY_MS },
    { reason: "cron-in-progress", defer: false, retryMs: 1_000 },
  ])(
    "settles $reason only with a private disposition (defer=$defer)",
    async ({ reason, defer, retryMs }) => {
      const skipped = {
        status: "skipped" as const,
        reason,
        ...(defer ? { retryAtMs: Date.now() + 60_000 } : {}),
      };
      const dispositions: boolean[][] = [];
      const handler = vi.fn<WakeHandler>(async (): ReturnType<WakeHandler> => {
        if (defer) {
          dispositions.push([
            isSessionEventWakePollDeferred(),
            deferSessionEventWakePoll(),
            isSessionEventWakePollDeferred(),
          ]);
        }
        return handler.mock.calls.length === 1 ? skipped : terminalFailure;
      });
      setSessionEventWakeHandler(handler);
      const settled = vi.fn();
      const result = requestSessionEventWakeAndWait(nativePoll({ coalesceMs: 100 }));
      void result.then(settled);

      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledOnce();
      if (defer) {
        expect(dispositions).toEqual([[false, true, true]]);
        expect(settled).toHaveBeenCalledExactlyOnceWith(skipped);
        expect(await result).toBe(skipped);
        await vi.advanceTimersByTimeAsync(601_000);
        expect(handler).toHaveBeenCalledOnce();
        expect(settled).toHaveBeenCalledOnce();
        return;
      }
      await vi.advanceTimersByTimeAsync(retryMs - 1);
      expect(handler).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(settled).toHaveBeenCalledExactlyOnceWith(terminalFailure);
      expect(await result).toBe(terminalFailure);
    },
  );

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
  const ineligibleCases: Array<
    [string, Partial<WakeRequest>, ("ineligible-first" | "native-first")?, number?]
  > = [
    [
      "missing target",
      { agentId: undefined, sessionKey: undefined },
      undefined,
      SESSION_EVENT_IDLE_RETRY_MS,
    ],
    [
      "global alias",
      { agentId: undefined, sessionKey: "global" },
      undefined,
      SESSION_EVENT_IDLE_RETRY_MS,
    ],
    ["missing cadence", { scheduledEveryMs: undefined }],
    ["missing cadence", { scheduledEveryMs: undefined }, "ineligible-first"],
    ["missing cadence", { scheduledEveryMs: undefined }, "native-first"],
    ["zero cadence", { scheduledEveryMs: 0 }],
    ["fractional cadence", { scheduledEveryMs: 1.5 }],
    ["unsafe cadence", { scheduledEveryMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["event", { source: "exec-event", intent: "event" }, "native-first"],
    ["manual", { source: "manual", intent: "manual" }, "ineligible-first"],
    ["immediate interval", { intent: "immediate" }, "native-first"],
    ["event interval", { intent: "event" }, "ineligible-first"],
    ["event source in scheduled slot", { source: "exec-event" }, "native-first"],
    ["scheduled task payload", { tasks: [task] }, "native-first"],
    ["task turn", { intent: "task", tasks: [task] }, "native-first"],
    ["empty task turn", { intent: "task" }, "ineligible-first"],
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
      const requests =
        order === undefined
          ? [invalid]
          : order === "ineligible-first"
            ? [invalid, valid]
            : [valid, invalid];
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
      const oldHandler = vi.fn<WakeHandler>(async () => {
        markSessionEventWakeWorkStarted();
        return { status: "skipped", reason };
      });
      setSessionEventWakeHandler(oldHandler);
      const settled = vi.fn();
      const result = requestSessionEventWakeAndWait(nativePoll());
      void result.then(settled);

      await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS);
      expect(oldHandler).toHaveBeenCalledTimes(2);
      expect(oldHandler.mock.calls[1]?.[0].retainedWork).toBe(true);
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
      expect(replacement.mock.calls[0]?.[0].retainedWork).toBeUndefined();
      expect(dispositions).toEqual([[false, false, false]]);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS);
      expect(replacement).toHaveBeenCalledTimes(2);
      expect(replacement.mock.calls[1]?.[0].retainedWork).toBe(true);
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

  it("does not carry a terminal attempt disposition into a replacement handler", async () => {
    const finishOld = createDeferred();
    const oldDispositions: boolean[] = [];
    const oldHandler = vi.fn<WakeHandler>(async () => {
      oldDispositions.push(deferSessionEventWakePoll());
      await finishOld.promise;
      return { status: "skipped", reason: "active-run" };
    });
    setSessionEventWakeHandler(oldHandler);
    const settled = vi.fn();
    const result = requestSessionEventWakeAndWait(nativePoll());
    void result.then(settled);

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(oldDispositions).toEqual([true]);
      expect(settled).not.toHaveBeenCalled();

      const replacementDispositions: boolean[] = [];
      const replacement = vi.fn<WakeHandler>(async () => {
        replacementDispositions.push(isSessionEventWakePollDeferred());
        return replacementDispositions.length === 1
          ? { status: "skipped", reason: "active-run" }
          : terminalFailure;
      });
      setSessionEventWakeHandler(replacement);
      await vi.advanceTimersByTimeAsync(250);
      expect(replacement).toHaveBeenCalledOnce();
      expect(replacementDispositions).toEqual([false]);
      expect(settled).not.toHaveBeenCalled();

      finishOld.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS);
      expect(replacement).toHaveBeenCalledTimes(2);
      expect(replacementDispositions).toEqual([false, false]);
      expect(settled).toHaveBeenCalledExactlyOnceWith(terminalFailure);
      expect(await result).toBe(terminalFailure);
    } finally {
      finishOld.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
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

  it("prevents an aborted old continuation from marking work or deferring the shared wake", async () => {
    const finishOld = createDeferred();
    const finishReplacement = createDeferred();
    const oldDispositions: boolean[] = [];
    let oldContextSignal: AbortSignal | undefined;
    let markReturned = false;
    let markError: unknown;
    const oldHandler = vi.fn<WakeHandler>(async () => {
      await finishOld.promise;
      oldContextSignal = getSessionEventWakeAbortSignal();
      oldDispositions.push(deferSessionEventWakePoll(), isSessionEventWakePollDeferred());
      try {
        markSessionEventWakeWorkStarted();
        markReturned = true;
      } catch (error) {
        markError = error;
      }
      return { status: "skipped", reason: "active-run" };
    });
    setSessionEventWakeHandler(oldHandler);
    const settled = vi.fn();
    const result = requestSessionEventWakeAndWait(nativePoll());
    void result.then(settled);

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(oldHandler).toHaveBeenCalledOnce();
      const oldSignal = oldHandler.mock.calls[0]?.[1];
      expect(oldSignal?.aborted).toBe(false);

      const replacementDispositions: boolean[] = [];
      const skipped = { status: "skipped" as const, reason: "active-run" };
      const replacement = vi.fn<WakeHandler>(async () => {
        await finishReplacement.promise;
        replacementDispositions.push(deferSessionEventWakePoll());
        return skipped;
      });
      setSessionEventWakeHandler(replacement);
      await vi.advanceTimersByTimeAsync(250);
      expect(replacement).toHaveBeenCalledOnce();
      expect(oldSignal?.aborted).toBe(true);
      expect(replacement.mock.calls[0]?.[1].aborted).toBe(false);

      finishOld.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(oldContextSignal).toBe(oldSignal);
      expect(oldDispositions).toEqual([false, false]);
      expect(markReturned).toBe(false);
      expect(markError).toBeDefined();
      expect(markError).toBe(oldSignal?.reason);
      expect(settled).not.toHaveBeenCalled();

      finishReplacement.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(replacementDispositions).toEqual([true]);
      expect(settled).toHaveBeenCalledExactlyOnceWith(skipped);
      expect(await result).toBe(skipped);
    } finally {
      finishOld.resolve();
      finishReplacement.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
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
});
