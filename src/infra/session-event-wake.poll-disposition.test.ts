import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  SESSION_EVENT_IDLE_RETRY_MS,
  getSessionEventWakeAbortSignal as getWakeSignal,
  isSessionEventWakePollDeferred as isDeferred,
  markSessionEventWakeWorkStarted as markStarted,
  requestSessionEventWake as requestWake,
  requestSessionEventWakeAndWait as requestAndWait,
  retireRefusedSessionEventWakePoll,
  setSessionEventWakeHandler as setHandlerRuntime,
} from "./session-event-wake.js";

describe("session event wake disposition and preemption", () => {
  type WakeRequest = Parameters<typeof requestAndWait>[0];
  type WakeHandler = NonNullable<Parameters<typeof setHandlerRuntime>[0]>;
  const cadenceMs = 5 * 60_000;
  const skipResult = (reason: string) => ({ status: "skipped" as const, reason });
  // Heartbeat dispatch retires a refused poll; the scheduler reads the disposition.
  function retireRefusedPoll(): boolean {
    retireRefusedSessionEventWakePoll();
    return isDeferred();
  }
  const dispositionsNow = () => [isDeferred(), retireRefusedPoll(), isDeferred()];
  const terminalFailure = { status: "failed" as const, reason: "test-terminal-failure" };
  const ran = { status: "ran" as const, durationMs: 1 };
  const noDisposition = [false, false, false];
  const pollChecks: [boolean[], boolean[]][] = [];
  let disposeHandler: (() => void) | undefined;
  function checkPoll(actual: boolean[], expected: boolean[]) {
    pollChecks.push([actual, expected]);
  }
  function install(implementation?: WakeHandler) {
    const handler = vi.fn<WakeHandler>(implementation);
    disposeHandler = setHandlerRuntime(handler);
    return handler;
  }
  function observe(request = nativePoll(), settled = vi.fn()) {
    const result = requestAndWait(request);
    void result.then(settled);
    return { settled, result };
  }
  async function advance(handler: ReturnType<typeof install>, ms: number, calls: number) {
    await vi.advanceTimersByTimeAsync(ms);
    expect(handler).toHaveBeenCalledTimes(calls);
  }
  async function expectTerminal({ settled, result }: ReturnType<typeof observe>) {
    expect(settled).toHaveBeenCalledExactlyOnceWith(terminalFailure);
    expect(await result).toBe(terminalFailure);
  }
  function sequence(...results: Awaited<ReturnType<WakeHandler>>[]) {
    const handler = install(results.length === 0 ? async () => ran : undefined);
    for (const result of [...results, ran]) {
      handler.mockResolvedValueOnce(result);
    }
    return handler;
  }
  function ineligiblePoll(retryMs = SESSION_EVENT_IDLE_RETRY_MS) {
    const handler = install(async () => {
      checkPoll(dispositionsNow(), noDisposition);
      return handler.mock.calls.length === 1
        ? { ...skipResult("requests-in-flight"), retryAtMs: Date.now() + retryMs }
        : terminalFailure;
    });
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
    const disposeDrain = setHandlerRuntime(async () => skipResult("disabled"));
    await vi.runAllTimersAsync();
    disposeDrain();
    disposeHandler = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    const checks = pollChecks.splice(0);
    expect(checks.map(([actual]) => actual)).toEqual(checks.map(([, expected]) => expected));
  });

  it("keeps private dispositions and started work separate across concurrent targets", async () => {
    expect(getWakeSignal()).toBeUndefined();
    expect(dispositionsNow()).toEqual(noDisposition);
    expect(() => markStarted()).not.toThrow();
    const bothStarted = createDeferred();
    const pollDeferred = createDeferred();
    let starts = 0;
    const skipped = skipResult("requests-in-flight");
    const handler = install(async (request, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(getWakeSignal()).toBe(signal);
      const admitted = request.agentId === "admitted";
      if (admitted) {
        markStarted();
      }
      if (++starts === 2) {
        bothStarted.resolve();
      }
      await bothStarted.promise;
      expect(getWakeSignal()).toBe(signal);
      if (!admitted) {
        expect([retireRefusedPoll(), isDeferred()]).toEqual([true, true]);
        pollDeferred.resolve();
        return skipped;
      }
      await pollDeferred.promise;
      expect(isDeferred()).toBe(false);
      expect(getWakeSignal()).toBe(signal);
      return terminalFailure;
    });
    const poll = requestAndWait(
      nativePoll({ agentId: "poll", sessionKey: "agent:poll:main", tasks: [] }),
    );
    const admitted = requestAndWait(
      nativePoll({ agentId: "admitted", sessionKey: "agent:admitted:main" }),
    );
    await vi.advanceTimersByTimeAsync(1);
    await expect(poll).resolves.toBe(skipped);
    await expect(admitted).resolves.toBe(terminalFailure);
    await vi.advanceTimersByTimeAsync(601_000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(getWakeSignal()).toBeUndefined();
    expect(isDeferred()).toBe(false);
  });

  const ineligibleCases: Array<[string, Partial<WakeRequest>]> = [
    ["global alias", { agentId: undefined, sessionKey: "global" }],
    ["missing cadence", { scheduledEveryMs: undefined }],
    ["event", { source: "exec-event", intent: "event" }],
    ["immediate interval", { intent: "immediate" }],
    ["task turn", { intent: "task", tasks: [{ jobId: "job", name: "job", prompt: "job" }] }],
  ];

  it.each(ineligibleCases)(
    "never grants poll eligibility to %s (case %#)",
    async (name, overrides) => {
      const nativeFirst = name !== "global alias";
      const retryMs = nativeFirst ? 1_000 : SESSION_EVENT_IDLE_RETRY_MS;
      const handler = ineligiblePoll(retryMs);
      const invalid = nativePoll({ ...overrides, coalesceMs: 100 });
      const valid = nativePoll({ coalesceMs: 100 });
      const requests = nativeFirst ? [valid, invalid] : [invalid];
      const settled = vi.fn();
      const results = requests.map((request) => observe(request, settled).result);
      await advance(handler, 100, 1);
      expect(settled).not.toHaveBeenCalled();
      if (name === "missing cadence") {
        // The merged public request looks native; eligibility must retain both admissions.
        expect(handler.mock.calls[0]?.[0]).toMatchObject({
          source: "interval",
          intent: "scheduled",
          scheduledEveryMs: cadenceMs,
        });
      }
      await advance(handler, retryMs, 2);
      expect(settled).toHaveBeenCalledTimes(results.length);
      for (const result of results) {
        expect(await result).toBe(terminalFailure);
      }
    },
  );

  it("preserves started work through preempted retry and handler replacement", async () => {
    const target = { agentId: "retry-owner", sessionKey: "agent:retry-owner:background" };
    const oldHandler = install(async () => {
      markStarted();
      return skipResult("preempted");
    });
    const observed = observe(nativePoll(target));
    await advance(oldHandler, SESSION_EVENT_IDLE_RETRY_MS - 1, 1);
    await advance(oldHandler, 1, 2);
    expect(oldHandler.mock.calls[1]?.[0]).toMatchObject({ ...target, retainedWork: true });
    expect(observed.settled).not.toHaveBeenCalled();
    const replacement = ineligiblePoll();
    await advance(replacement, 250, 1);
    expect(replacement.mock.calls[0]?.[0]).toMatchObject(target);
    expect(replacement.mock.calls[0]?.[0].retainedWork).toBeUndefined();
    expect(observed.settled).not.toHaveBeenCalled();
    await advance(replacement, SESSION_EVENT_IDLE_RETRY_MS, 2);
    expect(replacement.mock.calls[1]?.[0]).toMatchObject({ ...target, retainedWork: true });
    await expectTerminal(observed);
  });

  it.each(["while-active", "after-retained"])(
    "keeps started work sticky when a later native poll joins %s",
    async (enqueueAt) => {
      const finishFirst = createDeferred();
      const handler = install(async () => {
        if (handler.mock.calls.length === 1) {
          markStarted();
          await finishFirst.promise;
          return skipResult("preempted");
        }
        checkPoll([retireRefusedPoll()], [false]);
        return handler.mock.calls.length === 2
          ? { ...skipResult("requests-in-flight"), retryAtMs: Date.now() + 1_000 }
          : terminalFailure;
      });
      const { settled, result: original } = observe();
      const laterRequest = nativePoll({ scheduledEveryMs: 2 * cadenceMs });
      let later: ReturnType<typeof requestAndWait> | undefined;
      try {
        await advance(handler, 1, 1);
        if (enqueueAt === "while-active") {
          later = requestAndWait(laterRequest);
        }
        finishFirst.resolve();
        await vi.advanceTimersByTimeAsync(0);
        later ??= requestAndWait(laterRequest);
        void later.then(settled);
        await advance(handler, SESSION_EVENT_IDLE_RETRY_MS, 2);
        expect(handler.mock.calls[1]?.[0].scheduledEveryMs).toBe(2 * cadenceMs);
        expect(settled).not.toHaveBeenCalled();
        await advance(handler, 1_000, 3);
        expect(settled).toHaveBeenCalledTimes(2);
        expect(await Promise.all([original, later])).toEqual([terminalFailure, terminalFailure]);
      } finally {
        finishFirst.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it.each([
    { name: "native poll", request: {}, startedBefore: false, retired: true },
    { name: "native poll retry", request: {}, startedBefore: true, retired: false },
    {
      name: "task turn",
      request: { intent: "task", tasks: [{ jobId: "job", name: "job", prompt: "job" }] },
      startedBefore: false,
      retired: false,
    },
  ] as const)("retires a refused $name only before earlier work: $retired", async (params) => {
    const skipped = skipResult("requests-in-flight");
    const handler = install(async () => {
      markStarted();
      // The refused attempt follows one admitted attempt when earlier work started.
      const refusal = handler.mock.calls.length - (params.startedBefore ? 1 : 0);
      if (refusal === 0) {
        return skipResult("preempted");
      }
      if (refusal > 1) {
        return terminalFailure;
      }
      retireRefusedSessionEventWakePoll();
      return skipped;
    });
    const result = requestAndWait(nativePoll(params.request));
    await vi.advanceTimersByTimeAsync(2 * SESSION_EVENT_IDLE_RETRY_MS + 1);
    const attempts = (params.startedBefore ? 1 : 0) + (params.retired ? 1 : 2);
    expect(handler).toHaveBeenCalledTimes(attempts);
    expect(await result).toBe(params.retired ? skipped : terminalFailure);
  });

  it("does not carry a failed occurrence's poll disposition into a fresh wake", async () => {
    const handler = install(async (): ReturnType<WakeHandler> => {
      checkPoll([isDeferred()], [false]);
      if (handler.mock.calls.length === 1) {
        checkPoll([retireRefusedPoll()], [true]);
        throw new Error("test-attempt-interrupted");
      }
      return handler.mock.calls.length === 2
        ? { ...skipResult("requests-in-flight"), retryAtMs: Date.now() + 1_000 }
        : terminalFailure;
    });
    const observed = observe();
    await advance(handler, 1, 1);
    await expect(observed.result).resolves.toEqual({
      status: "failed",
      reason: "test-attempt-interrupted",
    });
    const fresh = observe();
    await advance(handler, 1, 2);
    expect(fresh.settled).not.toHaveBeenCalled();
    await advance(handler, 1_000, 3);
    await expectTerminal(fresh);
  });

  it("cancels only the exact waiter without aborting its coalesced native poll", async () => {
    const finish = createDeferred();
    const waiterAbort = new AbortController();
    const skipped = skipResult("requests-in-flight");
    const cancelledResult = { status: "failed", reason: "heartbeat wake cancelled" };
    const handler = install(async () => {
      await finish.promise;
      checkPoll([retireRefusedPoll()], [true]);
      return skipped;
    });
    const first = requestAndWait(nativePoll({ coalesceMs: 100 }), {
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
      expect(cancelled).toHaveBeenCalledExactlyOnceWith(cancelledResult);
      expect(ownerSignal?.aborted).toBe(false);
      expect(surviving).not.toHaveBeenCalled();
      finish.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(surviving).toHaveBeenCalledExactlyOnceWith(skipped);
      expect(await second).toBe(skipped);
      expect(await first).toEqual(cancelledResult);
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
    requestWake(wake("exec-event", { agentId: "slow", coalesceMs: 60_000 }));
    vi.setSystemTime(Date.now() + 3_600_000);
    requestWake(wake("manual", { agentId: "urgent", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handler.mock.calls.map(([request]) => request)).toEqual([
      wake("manual", { agentId: "urgent" }),
    ]);
  });

  it("retries a retained wake on time after the wall clock changes", async () => {
    vi.setSystemTime(2_000_000_000_000);
    const handler = sequence({ ...skipResult("min-spacing"), retryAtMs: Date.now() + 1_000 });
    requestWake(wake("exec-event", { coalesceMs: 0 }));
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
    requestWake({ ...pendingWake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    const replacementHandler = sequence();
    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(retiredHandler).not.toHaveBeenCalled();
    expect(replacementHandler.mock.calls.map(([request]) => request)).toEqual([pendingWake]);
  });

  it("keeps manual requests-in-flight on the default retry delay", async () => {
    const handler = sequence(skipResult("active-run"));
    requestWake(wake("manual", { coalesceMs: 0 }));
    await advance(handler, 999, 1);
    await advance(handler, 1, 2);
  });

  it("keeps guarded event work retained through preemption", async () => {
    const handler = sequence(
      { ...skipResult("not-due"), retryAtMs: Date.now() + 30_000 },
      skipResult("preempted"),
    );
    requestWake(wake("exec-event", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({ retainedWork: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler.mock.calls[2]?.[0]).toMatchObject({ retainedWork: true });
  });
});
