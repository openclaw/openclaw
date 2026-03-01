import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTypingTtlCoordinator } from "./typing-ttl-coordinator.js";

describe("TypingTtlCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- TTL expiry ---

  it("fires stop() after TTL and removes session", () => {
    const warn = vi.fn();
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
    const stop = vi.fn();

    coordinator.register("ch:sess1", stop);
    expect(coordinator.activeCount()).toBe(1);
    expect(stop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(coordinator.activeCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("TTL expired"),
      expect.objectContaining({ key: "ch:sess1" }),
    );
  });

  it("does NOT fire stop() before TTL elapses", () => {
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 5_000 });
    const stop = vi.fn();

    coordinator.register("ch:sess1", stop);
    vi.advanceTimersByTime(4_999);
    expect(stop).not.toHaveBeenCalled();
  });

  // --- Deregister on clean stop ---

  it("deregister() prevents TTL from firing", () => {
    const warn = vi.fn();
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
    const stop = vi.fn();

    const deregister = coordinator.register("ch:sess1", stop);
    expect(coordinator.activeCount()).toBe(1);

    // Clean stop before TTL
    deregister();
    expect(coordinator.activeCount()).toBe(0);

    // TTL elapses — should NOT call stop()
    vi.advanceTimersByTime(10_000);
    expect(stop).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("deregister() is idempotent — calling twice is safe", () => {
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 5_000 });
    const stop = vi.fn();

    const deregister = coordinator.register("ch:sess1", stop);
    deregister();
    deregister(); // second call must not throw

    vi.advanceTimersByTime(10_000);
    expect(stop).not.toHaveBeenCalled();
    expect(coordinator.activeCount()).toBe(0);
  });

  // --- Double-stop idempotency ---

  it("stop() throwing is caught and does not propagate", () => {
    const warn = vi.fn();
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
    const stop = vi.fn().mockImplementation(() => {
      throw new Error("already stopped");
    });

    coordinator.register("ch:sess1", stop);
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    expect(stop).toHaveBeenCalledTimes(1);
    // Error should be reported as a warning
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("stop() threw"),
      expect.objectContaining({ key: "ch:sess1" }),
    );
  });

  // --- Re-registration replaces entry ---

  it("re-registering same key replaces previous TTL", () => {
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 10_000 });
    const stop1 = vi.fn();
    const stop2 = vi.fn();

    coordinator.register("ch:sess1", stop1, 3_000); // TTL 3s
    vi.advanceTimersByTime(2_000); // 2s elapsed

    // Re-register with new TTL — resets the clock
    coordinator.register("ch:sess1", stop2, 5_000);
    expect(coordinator.activeCount()).toBe(1);

    // Old TTL (3s total, 2s already elapsed) should have been cancelled
    vi.advanceTimersByTime(1_100); // Would have fired old TTL but should not
    expect(stop1).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4_000); // New TTL fires at 5s from re-registration
    expect(stop2).toHaveBeenCalledTimes(1);
  });

  // --- Multiple sessions ---

  it("tracks multiple sessions independently", () => {
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 10_000 });
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    const stop3 = vi.fn();

    coordinator.register("ch:sess1", stop1, 3_000);
    coordinator.register("ch:sess2", stop2, 6_000);
    const deregister3 = coordinator.register("ch:sess3", stop3, 5_000);

    expect(coordinator.activeCount()).toBe(3);

    vi.advanceTimersByTime(3_000);
    expect(stop1).toHaveBeenCalledTimes(1); // expired
    expect(stop2).not.toHaveBeenCalled();
    expect(stop3).not.toHaveBeenCalled();
    expect(coordinator.activeCount()).toBe(2);

    deregister3(); // clean stop for sess3
    expect(coordinator.activeCount()).toBe(1);

    vi.advanceTimersByTime(3_000);
    expect(stop2).toHaveBeenCalledTimes(1); // expired
    expect(stop3).not.toHaveBeenCalled(); // was deregistered cleanly
    expect(coordinator.activeCount()).toBe(0);
  });

  // --- Per-call TTL override ---

  it("respects per-call ttlMs override over default", () => {
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 30_000 });
    const stop = vi.fn();

    coordinator.register("ch:sess1", stop, 1_000); // override: 1s
    vi.advanceTimersByTime(999);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  // --- TTL disabled ---

  it("disabled TTL (ttlMs=0) never fires stop()", () => {
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 0 });
    const stop = vi.fn();

    const deregister = coordinator.register("ch:sess1", stop);
    vi.advanceTimersByTime(300_000);
    expect(stop).not.toHaveBeenCalled();
    deregister();
    expect(stop).not.toHaveBeenCalled();
  });
});
