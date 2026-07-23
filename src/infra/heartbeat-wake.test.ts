// Exercises heartbeat wake coalescing, retries, and skip handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_LANES_BUSY,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  setHeartbeatWakeHandler as setRuntimeHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("heartbeat-wake", () => {
  type HeartbeatWakeHandler = Parameters<typeof setRuntimeHeartbeatWakeHandler>[0];
  type WakeRequest = Parameters<typeof requestHeartbeat>[0];
  let currentHandlerDisposer: (() => void) | undefined;

  function setHeartbeatWakeHandler(handler: HeartbeatWakeHandler): () => void {
    const dispose = setRuntimeHeartbeatWakeHandler(handler);
    currentHandlerDisposer = dispose;
    return () => {
      dispose();
      if (currentHandlerDisposer === dispose) {
        currentHandlerDisposer = undefined;
      }
    };
  }

  function wake(reason: string, opts: Partial<WakeRequest> = {}): WakeRequest {
    const source =
      opts.source ??
      (reason === "interval"
        ? "interval"
        : reason === "manual"
          ? "manual"
          : reason === "retry"
            ? "retry"
            : reason === "exec-event"
              ? "exec-event"
              : reason.startsWith("cron:")
                ? "cron"
                : reason.startsWith("hook:")
                  ? "hook"
                  : "other");
    const intent =
      opts.intent ??
      (reason === "interval" ? "scheduled" : reason === "manual" ? "manual" : "event");
    return { source, intent, reason, ...opts };
  }

  function setRetryOnceHeartbeatHandler() {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    return handler;
  }

  function expectWakeCall(handler: ReturnType<typeof vi.fn>, index: number, request: WakeRequest) {
    const [actualRequest] = handler.mock.calls[index] ?? [];
    expect(actualRequest).toEqual(request);
  }

  async function expectRetryAfterDefaultDelay(params: {
    handler: ReturnType<typeof vi.fn>;
    initialReason: string;
    expectedRetryReason: string;
  }) {
    setHeartbeatWakeHandler(
      params.handler as unknown as Parameters<typeof setHeartbeatWakeHandler>[0],
    );
    requestHeartbeat(wake(params.initialReason, { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(1);
    expect(params.handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(params.handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(params.handler).toHaveBeenCalledTimes(2);
    expectWakeCall(params.handler, 1, wake(params.expectedRetryReason));
  }

  beforeEach(() => {
    resetGatewayWorkAdmission();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    if (vi.isFakeTimers()) {
      currentHandlerDisposer?.();
      currentHandlerDisposer = setRuntimeHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.runAllTimersAsync();
    }
    currentHandlerDisposer?.();
    currentHandlerDisposer = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drains a pending wake once a handler is registered", async () => {
    vi.useFakeTimers();

    requestHeartbeat(wake("manual", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    const handler = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    setHeartbeatWakeHandler(handler);
    await vi.advanceTimersByTimeAsync(249);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(wake("manual"));
  });

  it("defers a full wake while gateway suspension is prepared", async () => {
    vi.useFakeTimers();
    const activeRootCounts: number[] = [];
    const handler = vi.fn(async () => {
      activeRootCounts.push(getActiveGatewayRootWorkCount());
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledOnce();
    expect(activeRootCounts).toEqual([1]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("counts an in-flight wake until the whole handler settles", async () => {
    vi.useFakeTimers();
    let finishWake: (() => void) | undefined;
    const wakeFinished = new Promise<void>((resolve) => {
      finishWake = resolve;
    });
    const handler = vi.fn(async () => {
      await wakeFinished;
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("manual", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(suspension?.rollback()).toBe(true);

    finishWake?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("coalesces multiple wake requests into one highest-priority run", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("interval", { coalesceMs: 200 }));
    requestHeartbeat(wake("exec-event", { coalesceMs: 200 }));
    requestHeartbeat(wake("retry", { coalesceMs: 200 }));

    await vi.advanceTimersByTimeAsync(199);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(wake("exec-event"));
  });

  it("retries requests-in-flight after the default retry delay", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    await expectRetryAfterDefaultDelay({
      handler,
      initialReason: "interval",
      expectedRetryReason: "interval",
    });
  });

  it.each([HEARTBEAT_SKIP_CRON_IN_PROGRESS, HEARTBEAT_SKIP_LANES_BUSY])(
    "retries %s after the default retry delay",
    async (reason) => {
      vi.useFakeTimers();
      const handler = vi
        .fn()
        .mockResolvedValueOnce({ status: "skipped", reason })
        .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
      await expectRetryAfterDefaultDelay({
        handler,
        initialReason: "interval",
        expectedRetryReason: "interval",
      });
    },
  );

  it("keeps retry cooldown even when a sooner request arrives", async () => {
    vi.useFakeTimers();
    const handler = setRetryOnceHeartbeatHandler();

    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);

    // Retry is now waiting for 1000ms. This should not preempt cooldown.
    requestHeartbeat(wake("hook:wake", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(998);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expectWakeCall(handler, 1, wake("hook:wake"));
  });

  it("retries thrown handler errors after the default retry delay", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "skipped", reason: "disabled" });
    await expectRetryAfterDefaultDelay({
      handler,
      initialReason: "exec-event",
      expectedRetryReason: "exec-event",
    });
  });

  it("preempts existing timer when a sooner schedule is requested", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    // Schedule for 5 seconds from now
    requestHeartbeat(wake("slow", { coalesceMs: 5000 }));

    // Schedule for 100ms from now — should preempt the 5s timer
    requestHeartbeat(wake("fast", { coalesceMs: 100 }));

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    // The reason should be "fast" since it was set last
    expect(handler).toHaveBeenCalledWith(wake("fast"));
  });

  it("keeps existing timer when later schedule is requested", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    // Schedule for 100ms from now
    requestHeartbeat(wake("fast", { coalesceMs: 100 }));

    // Schedule for 5 seconds from now — should NOT preempt
    requestHeartbeat(wake("slow", { coalesceMs: 5000 }));

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("clamps oversized coalesce delays instead of firing immediately", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("slow", { coalesceMs: Number.MAX_SAFE_INTEGER }));

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not downgrade a higher-priority pending reason", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("exec-event", { coalesceMs: 100 }));
    requestHeartbeat(wake("retry", { coalesceMs: 100 }));

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(wake("exec-event"));
  });

  it("does not let a stale run release a replacement handler's execution slot", async () => {
    vi.useFakeTimers();

    let resolveA!: () => void;
    let resolveB!: () => void;
    const pendingA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const pendingB = new Promise<void>((resolve) => {
      resolveB = resolve;
    });
    const handlerA = vi
      .fn()
      .mockReturnValue(pendingA.then(() => ({ status: "ran" as const, durationMs: 1 })));
    const handlerB = vi
      .fn()
      .mockReturnValue(pendingB.then(() => ({ status: "ran" as const, durationMs: 1 })));
    setHeartbeatWakeHandler(handlerA);

    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledTimes(1);

    setHeartbeatWakeHandler(handlerB);
    requestHeartbeat(wake("manual", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledTimes(1);

    resolveA();
    await vi.advanceTimersByTimeAsync(0);

    requestHeartbeat(wake("hook:after-restart", { coalesceMs: 100 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(handlerB).toHaveBeenCalledTimes(1);

    resolveB();
    await vi.advanceTimersByTimeAsync(0);
    expect(handlerB).toHaveBeenCalledTimes(2);
    expectWakeCall(handlerB, 1, wake("hook:after-restart"));
  });

  it("does not let a stale run preempt a replacement handler timer", async () => {
    vi.useFakeTimers();

    let resolveA!: () => void;
    const pendingA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const handlerA = vi
      .fn()
      .mockReturnValue(pendingA.then(() => ({ status: "ran" as const, durationMs: 1 })));
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerA);

    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledTimes(1);

    setHeartbeatWakeHandler(handlerB);
    requestHeartbeat(wake("manual", { coalesceMs: 1_000 }));

    resolveA();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(handlerB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledWith(wake("manual"));
  });

  it("does not let a stale busy result queue a retry on a replacement handler", async () => {
    vi.useFakeTimers();

    let resolveA!: (result: { status: "skipped"; reason: string }) => void;
    const pendingA = new Promise<{ status: "skipped"; reason: string }>((resolve) => {
      resolveA = resolve;
    });
    const handlerA = vi.fn().mockReturnValue(pendingA);
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerA);

    requestHeartbeat(wake("interval", { coalesceMs: 0, agentId: "old" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledOnce();

    setHeartbeatWakeHandler(handlerB);
    requestHeartbeat(wake("manual", { coalesceMs: 2_000, agentId: "new" }));
    resolveA({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(handlerB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledWith(wake("manual", { agentId: "new" }));
  });

  it("does not let a stale rejection queue a retry on a replacement handler", async () => {
    vi.useFakeTimers();

    let rejectA!: (error: Error) => void;
    const pendingA = new Promise<never>((_resolve, reject) => {
      rejectA = reject;
    });
    const handlerA = vi.fn().mockReturnValue(pendingA);
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerA);

    requestHeartbeat(wake("interval", { coalesceMs: 0, agentId: "old" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledOnce();

    setHeartbeatWakeHandler(handlerB);
    requestHeartbeat(wake("manual", { coalesceMs: 2_000, agentId: "new" }));
    rejectA(new Error("stale run failed"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(handlerB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledWith(wake("manual", { agentId: "new" }));
  });

  it("hands unattempted stale batch entries to the replacement handler", async () => {
    vi.useFakeTimers();

    let resolveA!: () => void;
    const pendingA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const handlerA = vi
      .fn()
      .mockReturnValue(pendingA.then(() => ({ status: "ran" as const, durationMs: 1 })));
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerA);

    requestHeartbeat(wake("cron:first", { coalesceMs: 0, agentId: "first" }));
    requestHeartbeat(wake("cron:second", { coalesceMs: 0, agentId: "second" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerA).toHaveBeenCalledWith(wake("cron:first", { agentId: "first" }));

    setHeartbeatWakeHandler(handlerB);
    requestHeartbeat(wake("manual", { coalesceMs: 2_000, agentId: "second" }));
    resolveA();
    await vi.advanceTimersByTimeAsync(249);
    expect(handlerB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledWith(wake("manual", { agentId: "second" }));

    await vi.advanceTimersByTimeAsync(1_750);
    expect(handlerB).toHaveBeenCalledOnce();
  });

  it("does not let a stale disposer clear a newer handler", async () => {
    vi.useFakeTimers();
    const handlerA = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const disposeA = setHeartbeatWakeHandler(handlerA);
    setHeartbeatWakeHandler(handlerB);

    disposeA();
    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledOnce();
  });

  it("clears stale retry cooldown when a new handler is registered", async () => {
    vi.useFakeTimers();
    const handlerA = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
    setHeartbeatWakeHandler(handlerA);

    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledTimes(1);

    // Simulate SIGUSR1 startup with a fresh wake handler.
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerB);

    requestHeartbeat(wake("manual", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledWith(wake("manual"));
  });

  it("forwards wake target fields and preserves them across retries", async () => {
    vi.useFakeTimers();
    const handler = setRetryOnceHeartbeatHandler();

    requestHeartbeat({
      source: "cron",
      intent: "immediate",
      reason: "cron:job-1",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
      coalesceMs: 0,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expectWakeCall(handler, 0, {
      source: "cron",
      intent: "immediate",
      reason: "cron:job-1",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    expectWakeCall(handler, 1, {
      source: "cron",
      intent: "immediate",
      reason: "cron:job-1",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
    });
  });

  it("preserves heartbeat override when same-target wakes coalesce", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "manual",
      intent: "manual",
      reason: "manual",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "manual",
      intent: "manual",
      reason: "manual",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      coalesceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      source: "manual",
      intent: "manual",
      reason: "manual",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
    });
  });

  it("executes distinct targeted wakes queued in the same coalescing window", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "cron:job-a",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "cron:job-b",
      agentId: "main",
      sessionKey: "agent:main:forum:group:-1001",
      coalesceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    const handledRequests = handler.mock.calls
      .map((call) => call[0])
      .toSorted((left, right) => left.reason.localeCompare(right.reason));
    expect(handledRequests).toEqual([
      {
        source: "cron",
        intent: "event",
        reason: "cron:job-a",
        agentId: "ops",
        sessionKey: "agent:ops:guildchat:channel:alerts",
      },
      {
        source: "cron",
        intent: "event",
        reason: "cron:job-b",
        agentId: "main",
        sessionKey: "agent:main:forum:group:-1001",
      },
    ]);
  });
});
