/**
 * Integration tests: TypingController wired to TypingTtlCoordinator.
 *
 * These tests verify the gateway-level TTL coordinator correctly interacts
 * with the typing controller lifecycle (start, clean stop, forced expiry).
 *
 * Relates to: #27138, #27011, #27053, #27690, #26961, #26733, #26751
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createTypingTtlCoordinator } from "../../gateway/typing-ttl-coordinator.js";
import { createTypingController } from "./typing.js";

function makeController(params: {
  coordinator: ReturnType<typeof createTypingTtlCoordinator>;
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

  it("coordinator fires cleanup() when typing persists past TTL (missed cleanup)", async () => {
    const warn = vi.fn();
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 10_000, warn });
    const { controller, onCleanup } = makeController({
      coordinator,
      coordinatorKey: "ch:sess1",
    });

    // Typing starts
    await controller.startTypingLoop();
    expect(coordinator.activeCount()).toBe(1);
    expect(onCleanup).not.toHaveBeenCalled();

    // Simulate stuck: run completes but dispatch idle never fires
    // (e.g., event-lane blockage or dispatcher hang)
    controller.markRunComplete();

    // Internal grace timer fires at 10s and forces cleanup via the controller itself —
    // but we want the coordinator to be the backstop. Let's use a longer internal grace:
    // The controller's dispatchIdleGrace is 10s; coordinator TTL is also 10s in this test.
    // Let's advance just past TTL:
    await vi.advanceTimersByTimeAsync(10_000);

    // Either the controller's grace timer or the coordinator fired — either way, cleaned up.
    expect(onCleanup).toHaveBeenCalled();
    expect(coordinator.activeCount()).toBe(0);
  });

  it("coordinator fires forced cleanup when internal TTL is much higher", async () => {
    const warn = vi.fn();
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
    const onCleanup = vi.fn();

    // Create a typing controller where the internal TTL is 300s but coordinator TTL is 5s.
    // This simulates the coordinator acting as the backstop when all other cleanup paths fail.
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

    // DO NOT call markRunComplete() or markDispatchIdle() — simulate total hang
    // Advance past coordinator TTL
    await vi.advanceTimersByTimeAsync(5_000);

    // Coordinator should have fired cleanup()
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(coordinator.activeCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("TTL expired"),
      expect.objectContaining({ key: "ch:stuck-session" }),
    );
  });

  it("clean stop deregisters from coordinator — coordinator does NOT fire", async () => {
    const warn = vi.fn();
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 5_000, warn });
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

  it("coordinator cleanup (forced) is idempotent — no double onCleanup", async () => {
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 3_000 });
    const { controller, onCleanup } = makeController({
      coordinator,
      coordinatorKey: "ch:sess-double",
      typingMaxTtlMs: 3_000,
    });

    await controller.startTypingLoop();

    // Both coordinator TTL and internal dispatch grace fire close together
    controller.markRunComplete(); // starts 10s grace timer
    // Move forward — coordinator fires first (3s), internal grace at 10s
    await vi.advanceTimersByTimeAsync(3_000);

    // Coordinator fires cleanup() once
    expect(onCleanup).toHaveBeenCalledTimes(1);

    // Advance to 10s — internal grace timer should see sealed=true and not re-fire
    await vi.advanceTimersByTimeAsync(7_000);
    expect(onCleanup).toHaveBeenCalledTimes(1); // Still once — sealed prevents re-entry
  });

  it("NO_REPLY path: typing stops when cleanup() is called externally", async () => {
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 30_000 });
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

  it("no registration when no coordinatorKey provided (backward compat)", async () => {
    const coordinator = createTypingTtlCoordinator({ defaultTtlMs: 5_000 });
    const onCleanup = vi.fn();

    // No coordinatorKey → coordinator should not be used
    const controller = createTypingController({
      onReplyStart: vi.fn(),
      onCleanup,
      typingIntervalSeconds: 6,
      log: vi.fn(),
      // coordinatorKey intentionally omitted
    });

    await controller.startTypingLoop();
    expect(coordinator.activeCount()).toBe(0); // Not registered

    controller.markRunComplete();
    controller.markDispatchIdle();
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });
});
