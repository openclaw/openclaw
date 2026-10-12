import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { heartbeatLog } from "./heartbeat-log.js";
import {
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  requestHeartbeatAndWait,
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

  function expectWakeCall(handler: ReturnType<typeof vi.fn>, index: number, request: WakeRequest) {
    const [actualRequest] = handler.mock.calls[index] ?? [];
    expect(actualRequest).toEqual(request);
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

  it("coalesces a colliding scheduled wake into the task turn", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    const scheduled = wake("interval", {
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
      coalesceMs: 100,
    });
    const task = {
      source: "interval" as const,
      intent: "task" as const,
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      coalesceMs: 100,
    };

    for (const request of [task, scheduled]) {
      requestHeartbeat(request);
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
    });
  });

  it("runs equal-period tasks at staggered anchors by retaining the spaced task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    let lastRunAtMs: number | undefined;
    const successfulTaskRuns: string[] = [];
    const handler = vi.fn().mockImplementation(async (request: WakeRequest) => {
      const now = Date.now();
      if (lastRunAtMs !== undefined && now - lastRunAtMs < 30_000) {
        return {
          status: "skipped" as const,
          reason: "min-spacing",
          retryAtMs: lastRunAtMs + 30_000,
        };
      }
      lastRunAtMs = now;
      successfulTaskRuns.push(...(request.tasks ?? []).map((task) => task.jobId));
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    const requestTask = (jobId: string) =>
      requestHeartbeat({
        source: "interval",
        intent: "task",
        reason: `heartbeat-task:${jobId}`,
        agentId: "main",
        tasks: [{ jobId, name: jobId, prompt: `Run ${jobId}` }],
        coalesceMs: 0,
      });

    requestTask("job-a");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4_999);
    requestTask("job-b");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(25_000);

    await vi.advanceTimersByTimeAsync(29_999);
    requestTask("job-a");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4_999);
    requestTask("job-b");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(successfulTaskRuns).toEqual(["job-a", "job-b", "job-a", "job-b"]);
  });

  it("does not starve an aged event behind repeated task turns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    let lastRunAtMs: number | undefined;
    const successfulIntents: WakeRequest["intent"][] = [];
    const handler = vi.fn().mockImplementation(async (request: WakeRequest) => {
      const now = Date.now();
      if (lastRunAtMs !== undefined && now - lastRunAtMs < 30_000) {
        return {
          status: "skipped" as const,
          reason: "min-spacing",
          retryAtMs: lastRunAtMs + 30_000,
        };
      }
      lastRunAtMs = now;
      successfulIntents.push(request.intent);
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    const requestTask = (jobId: string) =>
      requestHeartbeat({
        source: "interval",
        intent: "task",
        reason: `heartbeat-task:${jobId}`,
        agentId: "main",
        tasks: [{ jobId, name: jobId, prompt: `Run ${jobId}` }],
        coalesceMs: 0,
      });

    requestTask("job-a");
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    await vi.advanceTimersByTimeAsync(19_999);
    requestTask("job-b");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10_000);

    await vi.advanceTimersByTimeAsync(9_999);
    requestTask("job-c");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(successfulIntents).toEqual(["task", "event", "task"]);
  });

  it("bounds merged task retry state and clears it after success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "min-spacing",
        retryAtMs: Date.now() + 30_000,
      })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    const requestTask = (jobId: string) =>
      requestHeartbeat({
        source: "interval",
        intent: "task",
        reason: `heartbeat-task:${jobId}`,
        agentId: "main",
        tasks: [{ jobId, name: jobId, prompt: `Run ${jobId}` }],
        coalesceMs: 0,
      });

    requestTask("job-a");
    await vi.advanceTimersByTimeAsync(1);
    requestTask("job-b");
    requestTask("job-c");
    await vi.advanceTimersByTimeAsync(29_999);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0].tasks).toEqual([
      { jobId: "job-a", name: "job-a", prompt: "Run job-a" },
      { jobId: "job-b", name: "job-b", prompt: "Run job-b" },
      { jobId: "job-c", name: "job-c", prompt: "Run job-c" },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledTimes(2);
    requestTask("job-d");
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[2]?.[0].tasks).toEqual([
      { jobId: "job-d", name: "job-d", prompt: "Run job-d" },
    ]);
  });

  it("does not let a retained event cooldown block independent task work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "not-due",
        retryAtMs: Date.now() + 30 * 60_000,
      })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({
      intent: "task",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
    });
  });

  it("does not let a retained event cooldown defer an immediate wake", async () => {
    const explicitWake = {
      source: "cron" as const,
      intent: "immediate" as const,
      reason: "cron:job-now",
    };
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "not-due",
        retryAtMs: Date.now() + 30 * 60_000,
      })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    requestHeartbeat({
      ...explicitWake,
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({
      ...explicitWake,
      agentId: "main",
      sessionKey: "agent:main:main",
    });
  });

  it("keeps a retained immediate wake guarded when an ordinary event joins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "not-due",
        retryAtMs: Date.now() + 30_000,
      })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "cron",
      intent: "immediate",
      reason: "cron:job-now",
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(29_997);
    expect(handler).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({
      source: "cron",
      intent: "immediate",
      reason: "cron:job-now",
    });
  });

  it("lets a fresh event run while a scheduled retry observes idle grace", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);

    requestHeartbeat(wake("hook:wake", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expectWakeCall(handler, 1, wake("hook:wake"));

    await vi.advanceTimersByTimeAsync(59_998);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[2]?.[0]).toEqual({ ...wake("interval"), retainedWork: true });
  });

  it("retries only the failed targeted wake without replaying completed siblings", async () => {
    const failedTarget = "b";
    vi.useFakeTimers();
    let remainingFailures = 2;
    const handler = vi.fn(async (request: WakeRequest) => {
      if (request.reason === `cron:job-${failedTarget}` && remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("heartbeat target failed");
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);

    for (const target of ["a", "b", "c"]) {
      requestHeartbeat({
        source: "cron",
        intent: "event",
        reason: `cron:job-${target}`,
        agentId: `agent-${target}`,
        sessionKey: `agent:agent-${target}:main`,
        coalesceMs: 100,
      });
    }

    await vi.advanceTimersByTimeAsync(100);

    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "cron:job-a",
      "cron:job-b",
      "cron:job-c",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(handler).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "cron:job-a",
      "cron:job-b",
      "cron:job-c",
      `cron:job-${failedTarget}`,
    ]);
    expect(handler.mock.calls[3]?.[0]).toMatchObject({
      agentId: `agent-${failedTarget}`,
      sessionKey: `agent:agent-${failedTarget}:main`,
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "cron:job-a",
      "cron:job-b",
      "cron:job-c",
      "cron:job-b",
      "cron:job-b",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("recovers interrupted wakes when a replacement handler is registered", async () => {
    vi.useFakeTimers();

    // Simulate a handler that's mid-execution when SIGUSR2 fires.
    // We do this by having the handler hang forever (never resolve).
    const { promise: hangPromise, resolve: resolveHang } = createDeferred();
    const handlerA = vi
      .fn()
      .mockReturnValue(hangPromise.then(() => ({ status: "ran" as const, durationMs: 1 })));
    setHeartbeatWakeHandler(handlerA);

    // Trigger the handler — it starts running but never finishes
    const recovered = requestHeartbeatAndWait(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledTimes(1);

    // Now simulate SIGUSR2: register a new handler while handlerA is still running.
    // Without the fix, `running` would stay true and handlerB would never fire.
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerB);

    // The replacement must handle both the interrupted global barrier and fresh
    // targeted work. The recovered barrier runs first so the two cannot overlap.
    requestHeartbeat(wake("interval", { agentId: "ready", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB.mock.calls.map(([request]) => request.agentId)).toEqual([undefined, "ready"]);
    await expect(recovered).resolves.toEqual({ status: "ran", durationMs: 1 });

    // Clean up the hanging promise
    resolveHang!();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not let a stale heartbeat lifecycle release a newer active wake", async () => {
    vi.useFakeTimers();
    let finishOldWake!: () => void;
    let finishNewWake!: () => void;
    const oldWakeFinished = new Promise<void>((resolve) => {
      finishOldWake = resolve;
    });
    const newWakeFinished = new Promise<void>((resolve) => {
      finishNewWake = resolve;
    });
    const oldHandler = vi.fn(async () => {
      await oldWakeFinished;
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(oldHandler);
    requestHeartbeat(wake("interval", { agentId: "main", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(oldHandler).toHaveBeenCalledOnce();

    const newHandler = vi.fn(async (_request: WakeRequest) => {
      await newWakeFinished;
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(newHandler);
    requestHeartbeat(wake("interval", { agentId: "main", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(newHandler).toHaveBeenCalledOnce();

    finishOldWake();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    requestHeartbeat(wake("manual", { agentId: "main", coalesceMs: 25 }));
    await vi.advanceTimersByTimeAsync(25);
    expect(newHandler).toHaveBeenCalledOnce();

    finishNewWake();
    await vi.advanceTimersByTimeAsync(25);
    expect(newHandler).toHaveBeenCalledTimes(2);
    expect(newHandler.mock.calls[1]?.[0]).toMatchObject({
      intent: "manual",
      reason: "manual",
      agentId: "main",
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("hands off only unfinished wakes when a replaced handler returns busy", async () => {
    vi.useFakeTimers();
    const { promise: oldWakeFinished, resolve: finishOldWake } = createDeferred();
    const oldHandler = vi.fn(async () => {
      await oldWakeFinished;
      return { status: "skipped" as const, reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT };
    });
    setHeartbeatWakeHandler(oldHandler);

    for (const target of ["a", "b"]) {
      requestHeartbeat({
        source: "cron",
        intent: target === "a" ? "task" : "event",
        reason: `cron:job-${target}`,
        agentId: "main",
        sessionKey: "agent:main:main",
        coalesceMs: 100,
      });
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(oldHandler).toHaveBeenCalledOnce();

    const newHandler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(newHandler);
    finishOldWake();
    await vi.advanceTimersByTimeAsync(250);

    expect(oldHandler).toHaveBeenCalledOnce();
    expect(newHandler.mock.calls.map(([request]) => request.reason)).toEqual([
      "cron:job-a",
      "cron:job-b",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
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

    // Simulate SIGUSR2 startup with a fresh wake handler.
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerB);

    requestHeartbeat(wake("manual", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledWith(wake("manual"));
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
  it("dispatches an urgent wake after the wall clock changes forward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("interval", { agentId: "slow", coalesceMs: 60_000 }));
    vi.setSystemTime(Date.now() + 3_600_000);
    requestHeartbeat(wake("manual", { agentId: "urgent", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).toHaveBeenCalledExactlyOnceWith(wake("manual", { agentId: "urgent" }));
  });

  it("keeps manual requests-in-flight on the default retry delay", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    requestHeartbeat(wake("manual", { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(999);
    expect(handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("heartbeat wake settlement", () => {
  let disposeHandler: (() => void) | undefined;

  afterEach(async () => {
    resetGatewayWorkAdmission();
    if (vi.isFakeTimers()) {
      disposeHandler?.();
      disposeHandler = setRuntimeHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.runAllTimersAsync();
    }
    disposeHandler?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setHandler(handler: Parameters<typeof setRuntimeHeartbeatWakeHandler>[0]) {
    disposeHandler = setRuntimeHeartbeatWakeHandler(handler);
  }

  it.each([false, true])("logs terminal wake failures with a waiter=%s", async (wait) => {
    vi.useFakeTimers();
    const error = vi.spyOn(heartbeatLog, "error").mockImplementation(() => {});
    const failure = { status: "failed" as const, reason: "synthetic target unavailable" };
    const handler = vi.fn().mockResolvedValue(failure);
    setHandler(handler);
    const request = {
      source: "exec-event" as const,
      intent: "event" as const,
      reason: "exec-event",
      agentId: "main",
      sessionKey: "agent:main:wake-failure",
      coalesceMs: 0,
    };
    const result = wait ? requestHeartbeatAndWait(request) : requestHeartbeat(request);

    await vi.runAllTimersAsync();

    expect(handler).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "session event wake failed; no wake retry scheduled",
      {
        source: "exec-event",
        intent: "event",
        agentId: "main",
        sessionKey: "agent:main:wake-failure",
        wakeReason: "exec-event",
        error: failure.reason,
      },
    );
    if (wait) {
      expect(await result).toEqual(failure);
    }
  });

  it.each(["absent", "queued", "running"])(
    "settles a waiter with an unavailable handler when %s",
    async (phase) => {
      vi.useFakeTimers();
      const release = createDeferred();
      setHandler(
        phase === "absent"
          ? null
          : async () => {
              await release.promise;
              return { status: "ran", durationMs: 1 };
            },
      );
      const controller = new AbortController();
      const result = requestHeartbeatAndWait(
        { source: "interval", intent: "scheduled", coalesceMs: 0 },
        { abortSignal: controller.signal },
      );
      try {
        if (phase === "running") {
          await vi.advanceTimersByTimeAsync(0);
        }
        if (phase !== "absent") {
          disposeHandler?.();
        }
        expect(await Promise.race([result, Promise.resolve("pending")])).toEqual({
          status: "skipped",
          reason: "handler-unavailable",
        });
        if (phase === "absent") {
          const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
          setHandler(handler);
          await vi.advanceTimersByTimeAsync(0);
          expect(handler).not.toHaveBeenCalled();
        }
      } finally {
        controller.abort();
        release.resolve();
        await result;
      }
    },
  );

  it("dispatches queued notifications after installation before a later target", async () => {
    vi.useFakeTimers();
    setHandler(null);
    const wake = { source: "session-state" as const, intent: "immediate" as const };
    requestHeartbeat({
      ...wake,
      sessionKey: "agent:main:ready",
      coalesceMs: 0,
    });
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 7 });
    setHandler(handler);
    const later = requestHeartbeatAndWait({
      ...wake,
      sessionKey: "agent:main:later",
      coalesceMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(handler.mock.calls.map(([request]) => request.sessionKey)).toEqual(["agent:main:ready"]);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(later).resolves.toEqual({ status: "ran", durationMs: 7 });
    expect(handler.mock.calls.map(([request]) => request.sessionKey)).toEqual([
      "agent:main:ready",
      "agent:main:later",
    ]);
  });

  it("settles coalesced heartbeat callers", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 7 });
    setHandler(handler);
    const wake = {
      source: "interval" as const,
      intent: "scheduled" as const,
      reason: "interval",
      agentId: "main",
    };
    const settled = vi.fn();
    const resultA = requestHeartbeatAndWait({ ...wake, coalesceMs: 100 });
    const resultB = requestHeartbeatAndWait({ ...wake, coalesceMs: 100 });
    void resultA.then(settled);
    void resultB.then(settled);
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledExactlyOnceWith(wake);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenNthCalledWith(1, { status: "ran", durationMs: 7 });
    expect(settled).toHaveBeenNthCalledWith(2, { status: "ran", durationMs: 7 });
    await expect(Promise.all([resultA, resultB])).resolves.toEqual([
      { status: "ran", durationMs: 7 },
      { status: "ran", durationMs: 7 },
    ]);
  });

  it("keeps an awaited cron wake pending across a retryable skip", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHandler(handler);
    const result = requestHeartbeatAndWait({
      source: "cron",
      intent: "scheduled",
      reason: "interval",
      coalesceMs: 0,
    });
    const settled = vi.fn();
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ status: "ran", durationMs: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
