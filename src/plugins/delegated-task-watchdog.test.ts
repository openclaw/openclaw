import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDelegatedTaskWatchdog,
  type DelegatedTaskWatchdogConfig,
  type WatchdogHeartbeatContext,
  type WatchdogTimeoutContext,
} from "./delegated-task-watchdog.js";

describe("createDelegatedTaskWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects heartbeatCadenceMs < 1", () => {
    expect(() =>
      createDelegatedTaskWatchdog({
        taskId: "t1",
        heartbeatCadenceMs: 0,
      }),
    ).toThrow(/heartbeatCadenceMs must be >= 1/);
  });

  it("fires heartbeat ticks at the configured cadence", () => {
    const onHeartbeat = vi.fn();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 100,
      onHeartbeat,
    });

    expect(handle.active).toBe(true);
    expect(handle.taskId).toBe("t1");

    vi.advanceTimersByTime(350);
    expect(onHeartbeat).toHaveBeenCalledTimes(3);

    const ctx: WatchdogHeartbeatContext = onHeartbeat.mock.calls[0][0];
    expect(ctx.taskId).toBe("t1");
    expect(ctx.tickNumber).toBe(1);
    expect(ctx.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(ctx.remainingMs).toBe(Infinity); // no deadline

    handle.cancel();
  });

  it("fires onTimeout when deadline is reached", () => {
    const onTimeout = vi.fn();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 50,
      deadlineAtMs: Date.now() + 200,
      onTimeout,
    });

    vi.advanceTimersByTime(200);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    const ctx: WatchdogTimeoutContext = onTimeout.mock.calls[0][0];
    expect(ctx.taskId).toBe("t1");
    expect(ctx.reason).toBe("deadline");

    // Watchdog auto-destroys after timeout.
    expect(handle.active).toBe(false);
  });

  it("stops heartbeat after timeout fires", () => {
    const onHeartbeat = vi.fn();
    const onTimeout = vi.fn();
    createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 50,
      deadlineAtMs: Date.now() + 150,
      onHeartbeat,
      onTimeout,
    });

    vi.advanceTimersByTime(300);
    // At 50, 100 → 2 heartbeats. Deadline at 150 fires timeout, clears timers.
    expect(onHeartbeat).toHaveBeenCalledTimes(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("cancel() stops all timers without firing onTimeout", () => {
    const onHeartbeat = vi.fn();
    const onTimeout = vi.fn();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 50,
      deadlineAtMs: Date.now() + 200,
      onHeartbeat,
      onTimeout,
    });

    vi.advanceTimersByTime(75);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);

    handle.cancel();
    expect(handle.active).toBe(false);

    vi.advanceTimersByTime(500);
    expect(onHeartbeat).toHaveBeenCalledTimes(1); // no more ticks
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("destroy() fires onTimeout with reason 'manual'", () => {
    const onTimeout = vi.fn();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 100,
      onTimeout,
    });

    handle.destroy();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0].reason).toBe("manual");
    expect(handle.active).toBe(false);
  });

  it("destroy() is idempotent — onTimeout fires at most once", () => {
    const onTimeout = vi.fn();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 100,
      onTimeout,
    });

    handle.destroy();
    handle.destroy();
    handle.destroy();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("cancel() is idempotent", () => {
    const onTimeout = vi.fn();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 100,
      onTimeout,
    });

    handle.cancel();
    handle.cancel();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(handle.active).toBe(false);
  });

  it("extend() moves the deadline forward", () => {
    const onTimeout = vi.fn();
    const now = Date.now();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 50,
      deadlineAtMs: now + 100,
      onTimeout,
    });

    // Before original deadline, extend it.
    vi.advanceTimersByTime(50);
    handle.extend(now + 250);

    // Original deadline at 100ms would have fired — but we extended.
    vi.advanceTimersByTime(60); // total 110ms
    expect(onTimeout).not.toHaveBeenCalled();

    // Now reach the new deadline.
    vi.advanceTimersByTime(150); // total 260ms > 250ms deadline
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0].reason).toBe("deadline");
  });

  it("extend() with a past deadline fires timeout immediately", () => {
    const onTimeout = vi.fn();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 100,
      onTimeout,
    });

    handle.extend(Date.now() - 1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0].reason).toBe("deadline");
    expect(handle.active).toBe(false);
  });

  it("extend() is a no-op after cancel", () => {
    const onTimeout = vi.fn();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 100,
      onTimeout,
    });

    handle.cancel();
    handle.extend(Date.now() + 5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("reports remainingMs correctly when a deadline is set", () => {
    const heartbeats: WatchdogHeartbeatContext[] = [];
    const now = Date.now();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 100,
      deadlineAtMs: now + 500,
      onHeartbeat: (ctx) => heartbeats.push(ctx),
    });

    vi.advanceTimersByTime(250);
    handle.cancel();

    // First tick at ~100ms → remaining ~400ms
    expect(heartbeats[0].remainingMs).toBeGreaterThanOrEqual(390);
    expect(heartbeats[0].remainingMs).toBeLessThanOrEqual(410);

    // Second tick at ~200ms → remaining ~300ms
    expect(heartbeats[1].remainingMs).toBeGreaterThanOrEqual(290);
    expect(heartbeats[1].remainingMs).toBeLessThanOrEqual(310);
  });

  it("survives onHeartbeat handler throwing", () => {
    const onHeartbeat = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const onTimeout = vi.fn();
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 50,
      deadlineAtMs: Date.now() + 160,
      onHeartbeat,
      onTimeout,
    });

    vi.advanceTimersByTime(160);
    // Heartbeat at 50, 100, 150 → 3 ticks despite errors
    expect(onHeartbeat).toHaveBeenCalledTimes(3);
    // Timeout still fires
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("survives onTimeout handler throwing", () => {
    const onTimeout = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const handle = createDelegatedTaskWatchdog({
      taskId: "t1",
      heartbeatCadenceMs: 50,
      deadlineAtMs: Date.now() + 100,
      onTimeout,
    });

    vi.advanceTimersByTime(100);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(handle.active).toBe(false);
  });
});
