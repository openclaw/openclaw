import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypingTtlCoordinator } from "./typing-ttl-coordinator.js";

describe("TypingTtlCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. TTL expiry fires cleanupFn
  it("fires cleanupFn after TTL expires", () => {
    const warn = vi.fn();
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
    const cleanupFn = vi.fn();

    coordinator.register("ch:sess1", cleanupFn);
    expect(coordinator.activeCount()).toBe(1);
    expect(cleanupFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);

    expect(cleanupFn).toHaveBeenCalledTimes(1);
    expect(coordinator.activeCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[typing-ttl] TTL expired for key ch:sess1"),
      expect.objectContaining({ key: "ch:sess1" }),
    );
  });

  // 2. Clean deregister cancels TTL (cleanup never fires)
  it("deregister() cancels the TTL — cleanupFn never fires", () => {
    const warn = vi.fn();
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
    const cleanupFn = vi.fn();

    const deregister = coordinator.register("ch:sess1", cleanupFn);
    expect(coordinator.activeCount()).toBe(1);

    // Clean stop before TTL elapses
    deregister();
    expect(coordinator.activeCount()).toBe(0);

    // Advance well past TTL — cleanupFn must not fire
    vi.advanceTimersByTime(10_000);
    expect(cleanupFn).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  // 3. Stale deregister does NOT clear a newer registration for the same key
  it("stale deregister does not clobber a newer registration for the same key", () => {
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 10_000 });
    const cleanupFn1 = vi.fn();
    const cleanupFn2 = vi.fn();

    // First registration
    const deregister1 = coordinator.register("ch:sess1", cleanupFn1, 3_000);
    vi.advanceTimersByTime(1_000); // 1s elapsed

    // Second registration for the same key (replaces first)
    coordinator.register("ch:sess1", cleanupFn2, 5_000);
    expect(coordinator.activeCount()).toBe(1);

    // Stale deregister from first registration — must NOT clear the new one
    deregister1();
    expect(coordinator.activeCount()).toBe(1); // New registration still active

    // Second cleanup fires at 5s from re-registration
    vi.advanceTimersByTime(5_000);
    expect(cleanupFn2).toHaveBeenCalledTimes(1);
    expect(cleanupFn1).not.toHaveBeenCalled();
    expect(coordinator.activeCount()).toBe(0);
  });

  // 4. Double-stop is idempotent (no throw, no extra calls)
  it("calling deregister() twice is idempotent — no throw, no extra cleanup", () => {
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 5_000 });
    const cleanupFn = vi.fn();

    const deregister = coordinator.register("ch:sess1", cleanupFn);
    deregister();
    expect(() => deregister()).not.toThrow(); // Second call must not throw

    vi.advanceTimersByTime(10_000);
    expect(cleanupFn).not.toHaveBeenCalled();
    expect(coordinator.activeCount()).toBe(0);
  });

  // 5. Re-registration after deregister works
  it("re-registration after deregister creates a fresh TTL", () => {
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 5_000 });
    const cleanupFn = vi.fn();

    const deregister1 = coordinator.register("ch:sess1", cleanupFn);
    deregister1(); // Clean stop
    expect(coordinator.activeCount()).toBe(0);

    // Re-register the same key
    coordinator.register("ch:sess1", cleanupFn);
    expect(coordinator.activeCount()).toBe(1);

    vi.advanceTimersByTime(5_000);
    expect(cleanupFn).toHaveBeenCalledTimes(1);
    expect(coordinator.activeCount()).toBe(0);
  });

  // 6. Multi-session tracking is independent
  it("tracks multiple sessions independently", () => {
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 10_000 });
    const clean1 = vi.fn();
    const clean2 = vi.fn();
    const clean3 = vi.fn();

    coordinator.register("ch:sess1", clean1, 3_000);
    coordinator.register("ch:sess2", clean2, 6_000);
    const deregister3 = coordinator.register("ch:sess3", clean3, 5_000);

    expect(coordinator.activeCount()).toBe(3);

    vi.advanceTimersByTime(3_000);
    expect(clean1).toHaveBeenCalledTimes(1); // expired
    expect(clean2).not.toHaveBeenCalled();
    expect(clean3).not.toHaveBeenCalled();
    expect(coordinator.activeCount()).toBe(2);

    deregister3(); // clean stop for sess3
    expect(coordinator.activeCount()).toBe(1);

    vi.advanceTimersByTime(3_000); // total 6s
    expect(clean2).toHaveBeenCalledTimes(1); // expired
    expect(clean3).not.toHaveBeenCalled(); // was deregistered cleanly
    expect(coordinator.activeCount()).toBe(0);
  });

  // 7. Error in cleanupFn is caught and logged, doesn't throw
  it("error thrown by cleanupFn is caught and logged — does not propagate", () => {
    const warn = vi.fn();
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
    const cleanupFn = vi.fn().mockImplementation(() => {
      throw new Error("already stopped");
    });

    coordinator.register("ch:sess1", cleanupFn);
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();

    expect(cleanupFn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[typing-ttl] cleanupFn threw"),
      expect.objectContaining({ key: "ch:sess1" }),
    );
  });

  // 8. Custom TTL is respected
  it("respects per-call ttlMs override", () => {
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 30_000 });
    const cleanupFn = vi.fn();

    coordinator.register("ch:sess1", cleanupFn, 1_000); // override: 1s
    vi.advanceTimersByTime(999);
    expect(cleanupFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  // 9. deregister returns false when entry already cleared, true when it cleared it
  it("deregister returns true when it cleared the entry, false when already cleared", () => {
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 5_000 });
    const cleanupFn = vi.fn();

    const deregister = coordinator.register("ch:sess1", cleanupFn);

    // First call: should return true (successfully cancelled)
    expect(deregister()).toBe(true);

    // Second call: entry already cleared, should return false
    expect(deregister()).toBe(false);

    // Register again, let TTL fire, then try deregistering
    const deregister2 = coordinator.register("ch:sess2", cleanupFn);
    vi.advanceTimersByTime(5_000); // TTL fires
    expect(deregister2()).toBe(false); // Already cleared by TTL
  });
});
