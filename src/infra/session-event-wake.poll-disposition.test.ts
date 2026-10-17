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
  const skipResult = (reason: string) => ({ status: "skipped" as const, reason });
  const dispositionsNow = () => [
    isSessionEventWakePollDeferred(),
    deferSessionEventWakePoll(),
    isSessionEventWakePollDeferred(),
  ];
  const terminalFailure = { status: "failed" as const, reason: "test-terminal-failure" };
  const noDisposition = [false, false, false];
  let disposeHandler: (() => void) | undefined;

  function setSessionEventWakeHandler(implementation: WakeHandler) {
    const handler = vi.fn<WakeHandler>(implementation);
    disposeHandler = setRuntimeSessionEventWakeHandler(handler);
    return handler;
  }

  function observe(request = nativePoll()) {
    const settled = vi.fn();
    const result = requestSessionEventWakeAndWait(request);
    void result.then(settled);
    return { settled, result };
  }

  async function advance(
    handler: ReturnType<typeof setSessionEventWakeHandler>,
    ms: number,
    calls: number,
  ) {
    await vi.advanceTimersByTimeAsync(ms);
    expect(handler).toHaveBeenCalledTimes(calls);
  }

  async function expectTerminal({ settled, result }: ReturnType<typeof observe>) {
    expect(settled).toHaveBeenCalledExactlyOnceWith(terminalFailure);
    expect(await result).toBe(terminalFailure);
  }

  function sequence(...results: Awaited<ReturnType<WakeHandler>>[]) {
    const ran = { status: "ran" as const, durationMs: 1 };
    const handler = vi.fn<WakeHandler>();
    for (const result of [...results, ran]) {
      handler.mockResolvedValueOnce(result);
    }
    if (results.length === 0) {
      handler.mockResolvedValue(ran);
    }
    disposeHandler = setRuntimeSessionEventWakeHandler(handler);
    return handler;
  }

  function wake(reason: "manual" | "exec-event", opts: Partial<WakeRequest> = {}) {
    const intent = reason === "manual" ? "manual" : "event";
    return { source: reason, intent, reason, ...opts } satisfies WakeRequest;
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
    const disposeDrain = setRuntimeSessionEventWakeHandler(async () => skipResult("disabled"));
    await vi.runAllTimersAsync();
    disposeDrain();
    disposeHandler = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps private dispositions and started work separate across concurrent targets", async () => {
    expect(getSessionEventWakeAbortSignal()).toBeUndefined();
    expect(dispositionsNow()).toEqual(noDisposition);
    expect(() => markSessionEventWakeWorkStarted()).not.toThrow();
    const bothStarted = createDeferred();
    const pollDeferred = createDeferred();
    let starts = 0;
    const skipped = { status: "skipped" as const, reason: "requests-in-flight" };
    const handler = setSessionEventWakeHandler(async (request, signal) => {
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
        expect([deferSessionEventWakePoll(), isSessionEventWakePollDeferred()]).toEqual([
          true,
          true,
        ]);
        pollDeferred.resolve();
        return skipped;
      }
      await pollDeferred.promise;
      expect(dispositionsNow()).toEqual(noDisposition);
      expect(getSessionEventWakeAbortSignal()).toBe(signal);
      return terminalFailure;
    });
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
      const handler = setSessionEventWakeHandler(async () => {
        dispositions.push(dispositionsNow());
        return dispositions.length === 1
          ? skipResult(
              retryMs === SESSION_EVENT_IDLE_RETRY_MS ? "requests-in-flight" : "cron-in-progress",
            )
          : terminalFailure;
      });
      const invalid = nativePoll({ ...overrides, coalesceMs: 100 });
      const valid = nativePoll({ coalesceMs: 100 });
      const requests = order === undefined ? [invalid] : [valid, invalid];
      const settled = vi.fn();
      const results = requests.map((request) => {
        const result = requestSessionEventWakeAndWait(request);
        void result.then(settled);
        return result;
      });

      await advance(handler, 100, 1);
      expect(dispositions).toEqual([noDisposition]);
      expect(settled).not.toHaveBeenCalled();
      if (name === "missing cadence" && order !== undefined) {
        // The merged public request looks native; eligibility must retain both admissions.
        expect(handler.mock.calls[0]?.[0]).toMatchObject({
          source: "interval",
          intent: "scheduled",
          scheduledEveryMs: cadenceMs,
        });
      }

      await advance(handler, retryMs, 2);
      expect(dispositions).toEqual([noDisposition, noDisposition]);
      expect(settled).toHaveBeenCalledTimes(results.length);
      for (const result of results) {
        expect(await result).toBe(terminalFailure);
      }
    },
  );

  it("preserves started work through preempted retry and handler replacement", async () => {
    const target = { agentId: "retry-owner", sessionKey: "agent:retry-owner:background" };
    const oldHandler = setSessionEventWakeHandler(async () => {
      markSessionEventWakeWorkStarted();
      return skipResult("preempted");
    });
    const observed = observe(nativePoll(target));

    await advance(oldHandler, SESSION_EVENT_IDLE_RETRY_MS - 1, 1);
    await advance(oldHandler, 1, 2);
    expect(oldHandler.mock.calls[1]?.[0]).toMatchObject({ ...target, retainedWork: true });
    expect(observed.settled).not.toHaveBeenCalled();

    const dispositions: boolean[][] = [];
    const replacement = setSessionEventWakeHandler(async () => {
      dispositions.push(dispositionsNow());
      return dispositions.length === 1 ? skipResult("requests-in-flight") : terminalFailure;
    });
    await advance(replacement, 250, 1);
    expect(replacement.mock.calls[0]?.[0]).toMatchObject(target);
    expect(replacement.mock.calls[0]?.[0].retainedWork).toBeUndefined();
    expect(dispositions).toEqual([noDisposition]);
    expect(observed.settled).not.toHaveBeenCalled();

    await advance(replacement, SESSION_EVENT_IDLE_RETRY_MS, 2);
    expect(replacement.mock.calls[1]?.[0]).toMatchObject({ ...target, retainedWork: true });
    expect(dispositions).toEqual([noDisposition, noDisposition]);
    await expectTerminal(observed);
  });

  it.each(["while-active", "after-retained"])(
    "keeps started work sticky when a later native poll joins %s",
    async (enqueueAt) => {
      const finishFirst = createDeferred();
      const dispositions: boolean[] = [];
      const handler = setSessionEventWakeHandler(async () => {
        if (handler.mock.calls.length === 1) {
          markSessionEventWakeWorkStarted();
          await finishFirst.promise;
          return skipResult("preempted");
        }
        dispositions.push(deferSessionEventWakePoll());
        return dispositions.length === 1 ? skipResult("cron-in-progress") : terminalFailure;
      });
      const { settled, result: original } = observe();
      const laterRequest = nativePoll({ scheduledEveryMs: 2 * cadenceMs });
      let later: ReturnType<typeof requestSessionEventWakeAndWait>;

      try {
        await advance(handler, 1, 1);
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

        await advance(handler, SESSION_EVENT_IDLE_RETRY_MS, 2);
        expect(handler.mock.calls[1]?.[0].scheduledEveryMs).toBe(2 * cadenceMs);
        expect(dispositions).toEqual([false]);
        expect(settled).not.toHaveBeenCalled();

        await advance(handler, 1_000, 3);
        expect(dispositions).toEqual([false, false]);
        expect(settled).toHaveBeenCalledTimes(2);
        expect(await Promise.all([original, later])).toEqual([terminalFailure, terminalFailure]);
      } finally {
        finishFirst.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it.each(["work starts", "attempt throws"])(
    "revokes a tentative poll disposition when %s",
    async (outcome) => {
      const throws = outcome === "attempt throws";
      const dispositions: boolean[] = [];
      const handler = setSessionEventWakeHandler(async (): ReturnType<WakeHandler> => {
        if (throws) {
          dispositions.push(isSessionEventWakePollDeferred());
        }
        if (handler.mock.calls.length === 1) {
          dispositions.push(deferSessionEventWakePoll());
          if (throws) {
            throw new Error("test-attempt-interrupted");
          }
          markSessionEventWakeWorkStarted();
          dispositions.push(isSessionEventWakePollDeferred(), deferSessionEventWakePoll());
          return skipResult("active-run");
        }
        if (!throws) {
          dispositions.push(deferSessionEventWakePoll());
        }
        return throws && handler.mock.calls.length === 2
          ? skipResult("cron-in-progress")
          : terminalFailure;
      });
      const observed = observe();
      await advance(handler, throws ? 1_000 : 1, throws ? 2 : 1);
      expect(dispositions).toEqual(throws ? [false, true, false] : [true, false, false]);
      expect(observed.settled).not.toHaveBeenCalled();
      await advance(handler, throws ? 1_000 : SESSION_EVENT_IDLE_RETRY_MS, throws ? 3 : 2);
      expect(dispositions).toEqual(
        throws ? [false, true, false, false] : [true, false, false, false],
      );
      await expectTerminal(observed);
    },
  );

  it("cancels only the exact waiter without aborting its coalesced native poll", async () => {
    const finish = createDeferred();
    const waiterAbort = new AbortController();
    const skipped = { status: "skipped" as const, reason: "requests-in-flight" };
    const dispositions: boolean[] = [];
    const handler = setSessionEventWakeHandler(async () => {
      await finish.promise;
      dispositions.push(deferSessionEventWakePoll());
      return skipped;
    });
    const first = requestSessionEventWakeAndWait(nativePoll({ coalesceMs: 100 }), {
      abortSignal: waiterAbort.signal,
    });
    const { result: second, settled: surviving } = observe(nativePoll({ coalesceMs: 100 }));
    const cancelled = vi.fn();
    void first.then(cancelled);

    try {
      await advance(handler, 100, 1);
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

      await advance(handler, 601_000, 1);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(surviving).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("dispatches an urgent wake after the wall clock changes forward", async () => {
    vi.setSystemTime(2_000_000_000_000);
    const handler = sequence();

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
    const handler = sequence({ ...skipResult("min-spacing"), retryAtMs: Date.now() + 1_000 });

    requestSessionEventWake(wake("exec-event", { coalesceMs: 0 }));
    await advance(handler, 1, 1);
    vi.setSystemTime(Date.now() - 86_400_000);
    await advance(handler, 998, 1);

    await advance(handler, 1, 2);
  });

  it("hands a suspended wake to the replacement without running the retired handler", async () => {
    const retiredHandler = sequence();
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
    const replacementHandler = sequence();
    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);

    expect(retiredHandler).not.toHaveBeenCalled();
    expect(replacementHandler.mock.calls.map(([request]) => request)).toEqual([pendingWake]);
  });

  it("keeps manual requests-in-flight on the default retry delay", async () => {
    const handler = sequence(skipResult("active-run"));
    requestSessionEventWake(wake("manual", { coalesceMs: 0 }));

    await advance(handler, 999, 1);
    await advance(handler, 1, 2);
  });

  it("keeps guarded event work retained through preemption", async () => {
    const handler = sequence(
      { ...skipResult("not-due"), retryAtMs: Date.now() + 30_000 },
      skipResult("preempted"),
    );
    requestSessionEventWake(wake("exec-event", { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({ retainedWork: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler.mock.calls[2]?.[0]).toMatchObject({ retainedWork: true });
  });
});
