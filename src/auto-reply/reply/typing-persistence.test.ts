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

  it("keeps typing alive while keepalive ticks continue during long runs", async () => {
    const longRunCleanupSpy = vi.fn();
    const longRunController = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: longRunCleanupSpy,
      typingIntervalSeconds: 6,
      typingTtlMs: 10_000,
      log: vi.fn(),
    });

    await longRunController.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(longRunCleanupSpy).not.toHaveBeenCalled();

    longRunController.cleanup();
    expect(longRunCleanupSpy).toHaveBeenCalledTimes(1);
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

  it("returns an inert controller when typing callbacks are absent", async () => {
    const inert = createTypingController({});

    await inert.onReplyStart();
    await inert.startTypingLoop();
    await inert.startTypingOnText("hello");
    inert.refreshTypingTtl();
    inert.markRunComplete();
    inert.markDispatchIdle();
    inert.markSourceReplyDelivered();
    inert.cleanup();

    expect(inert.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Issue #84276: in `message_tool_only` source-reply mode the visible reply is
  // delivered through the message(action=send) tool. Without an explicit signal
  // the keepalive loop can fire one more `sendTyping` while the tool is in
  // flight, leaving the channel-side typing TTL refreshed for the full
  // ~10 seconds after the user sees the reply. `markSourceReplyDelivered()`
  // must stop the keepalive immediately and seal the controller.
  describe("markSourceReplyDelivered (issue #84276)", () => {
    it("stops the keepalive loop immediately on visible source-reply delivery", async () => {
      await controller.startTypingLoop();
      expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

      controller.markSourceReplyDelivered();

      expect(onCleanupSpy).toHaveBeenCalledTimes(1);

      // No further keepalive ticks should issue typing pings after delivery.
      vi.advanceTimersByTime(6000);
      vi.advanceTimersByTime(6000);
      vi.advanceTimersByTime(6000);
      expect(onReplyStartSpy).toHaveBeenCalledTimes(1);
    });

    it("seals the controller so late markRunComplete/markDispatchIdle are no-ops", async () => {
      await controller.startTypingLoop();
      controller.markSourceReplyDelivered();
      expect(onCleanupSpy).toHaveBeenCalledTimes(1);

      controller.markRunComplete();
      controller.markDispatchIdle();
      controller.cleanup();

      expect(onCleanupSpy).toHaveBeenCalledTimes(1);
      expect(controller.isActive()).toBe(false);
    });

    it("is idempotent across repeated calls", async () => {
      await controller.startTypingLoop();
      controller.markSourceReplyDelivered();
      controller.markSourceReplyDelivered();
      controller.markSourceReplyDelivered();

      expect(onCleanupSpy).toHaveBeenCalledTimes(1);
    });

    it("clears the dispatch-idle grace timer if markRunComplete fired first", async () => {
      await controller.startTypingLoop();
      controller.markRunComplete();

      // The 10 s grace timer is now armed; markSourceReplyDelivered should
      // clean up immediately without waiting for it.
      expect(onCleanupSpy).not.toHaveBeenCalled();
      controller.markSourceReplyDelivered();
      expect(onCleanupSpy).toHaveBeenCalledTimes(1);

      // Advancing past the original 10s grace must not trigger a second cleanup.
      vi.advanceTimersByTime(10_000);
      expect(onCleanupSpy).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when typing was never started", () => {
      controller.markSourceReplyDelivered();
      // No keepalive started, so no channel cleanup signal should fire.
      expect(onCleanupSpy).not.toHaveBeenCalled();
      expect(onReplyStartSpy).not.toHaveBeenCalled();
    });
  });
});
