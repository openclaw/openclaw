import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createTypingController } from "./typing.js";

describe("typing persistence bug fix", () => {
  let onReplyStartSpy: Mock;
  let onCleanupSpy: Mock;
  let controller: ReturnType<typeof createTypingController>;

  beforeEach(() => {
    vi.useFakeTimers();
    onReplyStartSpy = vi.fn();
    onCleanupSpy = vi.fn();

    controller = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 6,
      log: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should NOT restart typing after markRunComplete is called", async () => {
    // Start typing normally
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run as complete (but not yet dispatch idle)
    controller.markRunComplete();

    // Advance time to trigger the typing interval (6 seconds)
    vi.advanceTimersByTime(6000);

    // BUG: The typing loop should NOT call onReplyStart again
    // because the run is already complete
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);
    expect(onReplyStartSpy).not.toHaveBeenCalledTimes(2);
  });

  it("should stop typing when both runComplete and dispatchIdle are true", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete
    controller.markRunComplete();
    expect(onCleanupSpy).not.toHaveBeenCalled();

    // Mark dispatch idle - should trigger cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);

    // After cleanup, typing interval should not restart typing
    vi.advanceTimersByTime(6000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1); // Still only the initial call
  });

  it("should prevent typing restart even if cleanup is delayed", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete (but dispatch not idle yet - simulating cleanup delay)
    controller.markRunComplete();

    // Multiple typing intervals should NOT restart typing
    vi.advanceTimersByTime(6000); // First interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Second interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Third interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Eventually dispatch becomes idle and triggers cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("does not leak keepalive loop when cleanup races during startTypingLoop", async () => {
    let resolveStart: () => void;
    const slowStart = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const ctrl = createTypingController({
      onReplyStart: slowStart,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 4,
      typingTtlMs: 10_000,
      log: vi.fn(),
    });

    // Start typing — ensureStart() will await the slow onReplyStart
    const loopPromise = ctrl.startTypingLoop();

    // While onReplyStart is pending, both signals arrive → cleanup fires
    ctrl.markRunComplete();
    ctrl.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);

    // Resolve the pending start — startTypingLoop should see sealed=true
    resolveStart!();
    await loopPromise;

    // The keepalive loop should NOT have been started (no leaked interval)
    await vi.advanceTimersByTimeAsync(20_000);
    // Only the initial call, no keepalive ticks
    expect(slowStart).toHaveBeenCalledTimes(1);
  });

  it("TTL fires independently even while keepalive loop is ticking", async () => {
    // Use a short TTL so the test doesn't need to advance 2 full minutes
    const ttlMs = 10_000;
    const ctrl = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 4,
      typingTtlMs: ttlMs,
      log: vi.fn(),
    });

    await ctrl.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Advance past several keepalive ticks but don't refresh TTL externally
    await vi.advanceTimersByTimeAsync(4_000); // tick 2
    await vi.advanceTimersByTimeAsync(4_000); // tick 3
    // keepalive is still ticking, but TTL has not been refreshed
    expect(onCleanupSpy).not.toHaveBeenCalled();

    // Advance to hit TTL (10s total)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);

    // No further ticks after cleanup
    const callsBefore = onReplyStartSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(callsBefore);
  });
});
