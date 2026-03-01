/**
 * Integration tests: TypingController wired to TypingTtlCoordinator.
 *
 * These tests verify the gateway-level TTL coordinator correctly interacts
 * with the typing controller lifecycle (start, clean stop, forced expiry).
 *
 * Relates to: #27138, #27011, #27053, #27690, #26961, #26733, #26751
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { TypingTtlCoordinator } from "../../gateway/typing-ttl-coordinator.js";
import { createTypingController } from "./typing.js";

function makeController(params: {
  coordinator: TypingTtlCoordinator;
  coordinatorKey: string;
  typingMaxTtlMs?: number;
  onReplyStart?: Mock;
  onCleanup?: Mock;
}) {
  const onReplyStart = params.onReplyStart ?? vi.fn();
  const onCleanup = params.onCleanup ?? vi.fn();
  const controller = createTypingController({
    onReplyStart,
    onCleanup,
    typingIntervalSeconds: 6,
    typingTtlMs: 300_000, // High internal TTL — we want coordinator to fire first
    log: vi.fn(),
    coordinatorKey: params.coordinatorKey,
    coordinator: params.coordinator,
    typingMaxTtlMs: params.typingMaxTtlMs,
  });
  return { controller, onReplyStart, onCleanup };
}

describe("TypingController + TypingTtlCoordinator integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Typing persists past TTL → coordinator fires cleanup
  it("coordinator fires cleanup() when typing persists past TTL (missed cleanup)", async () => {
    const warn = vi.fn();
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
    const onCleanup = vi.fn();

    // Create controller with a low coordinator TTL to simulate backstop behavior
    const controller = createTypingController({
      onReplyStart: vi.fn(),
      onCleanup,
      typingIntervalSeconds: 6,
      typingTtlMs: 300_000, // Very high internal TTL — won't fire
      log: vi.fn(),
      coordinatorKey: "ch:stuck-session",
      coordinator,
      typingMaxTtlMs: 5_000, // Low coordinator TTL for the test
    });

    // Start typing (registers with coordinator)
    await controller.startTypingLoop();
    expect(coordinator.activeCount()).toBe(1);

    // Simulate total hang: markRunComplete with no markDispatchIdle
    // (in this typing.ts version, cleanup doesn't auto-fire without dispatchIdle)
    controller.markRunComplete();
    expect(onCleanup).not.toHaveBeenCalled(); // Not yet

    // Advance past coordinator TTL
    await vi.advanceTimersByTimeAsync(5_000);

    // Coordinator should have fired cleanup()
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(coordinator.activeCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[typing-ttl] TTL expired"),
      expect.objectContaining({ key: "ch:stuck-session" }),
    );
  });

  // 2. Clean stop before TTL → coordinator does NOT fire
  it("coordinator does NOT fire when typing stops cleanly before TTL", async () => {
    const warn = vi.fn();
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
    const { controller, onCleanup } = makeController({
      coordinator,
      coordinatorKey: "ch:clean-session",
    });

    await controller.startTypingLoop();
    expect(coordinator.activeCount()).toBe(1);

    // Normal clean stop: run completes + dispatch idle
    controller.markRunComplete();
    controller.markDispatchIdle();

    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(coordinator.activeCount()).toBe(0);

    // Advance past TTL — coordinator should NOT fire a second cleanup
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onCleanup).toHaveBeenCalledTimes(1); // Still only once
    expect(warn).not.toHaveBeenCalled();
  });

  // 3. NO_REPLY path → typing is stopped before TTL
  it("NO_REPLY path: coordinator deregisters when cleanup() is called externally", async () => {
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 30_000 });
    const { controller, onCleanup } = makeController({
      coordinator,
      coordinatorKey: "ch:no-reply-session",
    });

    await controller.startTypingLoop();
    expect(coordinator.activeCount()).toBe(1);

    // Simulate NO_REPLY: typing.cleanup() called by the dispatcher
    controller.cleanup();

    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(coordinator.activeCount()).toBe(0); // Deregistered on clean cleanup

    // TTL should not fire
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });

  // 4. Multiple overlapping sessions → each independently tracked
  it("multiple overlapping sessions are tracked independently", async () => {
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 10_000 });
    const onCleanup1 = vi.fn();
    const onCleanup2 = vi.fn();
    const onCleanup3 = vi.fn();

    const ctrl1 = createTypingController({
      onReplyStart: vi.fn(),
      onCleanup: onCleanup1,
      typingIntervalSeconds: 6,
      log: vi.fn(),
      coordinatorKey: "ch:sess1",
      coordinator,
      typingMaxTtlMs: 3_000,
    });
    const ctrl2 = createTypingController({
      onReplyStart: vi.fn(),
      onCleanup: onCleanup2,
      typingIntervalSeconds: 6,
      log: vi.fn(),
      coordinatorKey: "ch:sess2",
      coordinator,
      typingMaxTtlMs: 6_000,
    });
    const ctrl3 = createTypingController({
      onReplyStart: vi.fn(),
      onCleanup: onCleanup3,
      typingIntervalSeconds: 6,
      log: vi.fn(),
      coordinatorKey: "ch:sess3",
      coordinator,
      typingMaxTtlMs: 5_000,
    });

    await ctrl1.startTypingLoop();
    await ctrl2.startTypingLoop();
    await ctrl3.startTypingLoop();
    expect(coordinator.activeCount()).toBe(3);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(onCleanup1).toHaveBeenCalledTimes(1); // expired via coordinator
    expect(onCleanup2).not.toHaveBeenCalled();
    expect(onCleanup3).not.toHaveBeenCalled();

    // Clean stop for sess3
    ctrl3.markRunComplete();
    ctrl3.markDispatchIdle();
    expect(onCleanup3).toHaveBeenCalledTimes(1);
    expect(coordinator.activeCount()).toBe(1); // only sess2 remains

    await vi.advanceTimersByTimeAsync(3_000); // total 6s
    expect(onCleanup2).toHaveBeenCalledTimes(1); // expired via coordinator
    expect(coordinator.activeCount()).toBe(0);
  });

  // 5. Re-registration on interrupt → stale deregister doesn't break new session
  it("stale deregister from interrupted session does not break a new session for same key", async () => {
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 10_000 });
    const onCleanup1 = vi.fn();
    const onCleanup2 = vi.fn();

    // First session starts and is interrupted (cleanup called)
    const ctrl1 = createTypingController({
      onReplyStart: vi.fn(),
      onCleanup: onCleanup1,
      typingIntervalSeconds: 6,
      log: vi.fn(),
      coordinatorKey: "ch:shared-key",
      coordinator,
      typingMaxTtlMs: 5_000,
    });
    await ctrl1.startTypingLoop();
    expect(coordinator.activeCount()).toBe(1);

    // Interrupt ctrl1 (simulates session reset / NO_REPLY)
    ctrl1.cleanup();
    expect(coordinator.activeCount()).toBe(0);

    // New session with same key starts
    const ctrl2 = createTypingController({
      onReplyStart: vi.fn(),
      onCleanup: onCleanup2,
      typingIntervalSeconds: 6,
      log: vi.fn(),
      coordinatorKey: "ch:shared-key",
      coordinator,
      typingMaxTtlMs: 5_000,
    });
    await ctrl2.startTypingLoop();
    expect(coordinator.activeCount()).toBe(1);

    // New session cleans up normally
    ctrl2.markRunComplete();
    ctrl2.markDispatchIdle();

    expect(onCleanup2).toHaveBeenCalledTimes(1);
    expect(coordinator.activeCount()).toBe(0);

    // Advance past TTL — no spurious fire from stale first session
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onCleanup1).toHaveBeenCalledTimes(1); // Only from the explicit ctrl1.cleanup()
    expect(onCleanup2).toHaveBeenCalledTimes(1);
  });

  // 6. Coordinator error resilience → error in cleanup doesn't crash reply flow
  it("coordinator error resilience: error in cleanup fn does not crash the coordinator", async () => {
    const warn = vi.fn();
    const coordinator = new TypingTtlCoordinator({ defaultTtlMs: 3_000, warn });
    const onCleanup = vi.fn().mockImplementationOnce(() => {
      throw new Error("cleanup blew up");
    });

    const controller = createTypingController({
      onReplyStart: vi.fn(),
      onCleanup,
      typingIntervalSeconds: 6,
      typingTtlMs: 300_000,
      log: vi.fn(),
      coordinatorKey: "ch:error-session",
      coordinator,
      typingMaxTtlMs: 3_000,
    });

    await controller.startTypingLoop();
    expect(coordinator.activeCount()).toBe(1);

    // Advance to TTL — coordinator fires cleanup which throws
    expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();

    // Coordinator must have caught the error and logged it
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[typing-ttl] cleanupFn threw"),
      expect.objectContaining({ key: "ch:error-session" }),
    );
    expect(coordinator.activeCount()).toBe(0);
  });
});
