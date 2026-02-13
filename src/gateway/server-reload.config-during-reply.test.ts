/**
 * E2E test for config reload during active reply sending.
 * Tests that gateway restart is properly deferred until replies are sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllDispatchers,
  getTotalPendingReplies,
} from "../auto-reply/reply/dispatcher-registry.js";

// Helper to flush all pending microtasks
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("gateway config reload during reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Wait for any pending microtasks (from markComplete()) to complete
    await flushMicrotasks();
    clearAllDispatchers();
  });

  it("should defer restart until reply dispatcher completes", async () => {
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalQueueSize } = await import("../process/command-queue.js");

    // Create a dispatcher (simulating message handling)
    let deliveredReplies: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        // Simulate async reply delivery
        await new Promise((resolve) => setTimeout(resolve, 100));
        deliveredReplies.push(payload.text ?? "");
      },
      onError: (err) => {
        throw err;
      },
    });

    // Initially: pending=1 (reservation)
    expect(getTotalPendingReplies()).toBe(1);

    // Simulate command finishing and enqueuing reply
    dispatcher.sendFinalReply({ text: "Configuration updated successfully!" });

    // Now: pending=2 (reservation + 1 enqueued reply)
    expect(getTotalPendingReplies()).toBe(2);

    // Mark dispatcher complete (flags reservation for cleanup on last delivery)
    dispatcher.markComplete();

    // Reservation is still counted until the delivery .finally() clears it,
    // but the important invariant is pending > 0 while delivery is in flight.
    expect(getTotalPendingReplies()).toBeGreaterThan(0);

    // At this point, if gateway restart was requested, it should defer
    // because getTotalPendingReplies() > 0

    // Wait for reply to be delivered
    await dispatcher.waitForIdle();

    // Now: pending=0 (reply sent)
    expect(getTotalPendingReplies()).toBe(0);
    expect(deliveredReplies).toEqual(["Configuration updated successfully!"]);

    // Now restart can proceed safely
    expect(getTotalQueueSize()).toBe(0);
    expect(getTotalPendingReplies()).toBe(0);
  });

  it("should handle dispatcher reservation correctly when no replies sent", async () => {
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");

    let deliverCalled = false;
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        deliverCalled = true;
      },
    });

    // Initially: pending=1 (reservation)
    expect(getTotalPendingReplies()).toBe(1);

    // Mark complete without sending any replies
    dispatcher.markComplete();

    // Reservation is cleared via microtask — flush it
    await flushMicrotasks();

    // Now: pending=0 (reservation cleared, no replies were enqueued)
    expect(getTotalPendingReplies()).toBe(0);

    // Wait for idle (should resolve immediately since no replies)
    await dispatcher.waitForIdle();

    expect(deliverCalled).toBe(false);
    expect(getTotalPendingReplies()).toBe(0);
  });

  it("should integrate dispatcher reservation with concurrent dispatchers", async () => {
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalQueueSize } = await import("../process/command-queue.js");

    const deliveredReplies: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        deliveredReplies.push(payload.text ?? "");
      },
    });

    // Dispatcher has reservation (pending=1)
    expect(getTotalPendingReplies()).toBe(1);

    // Total active = queue + pending
    const totalActive = getTotalQueueSize() + getTotalPendingReplies();
    expect(totalActive).toBe(1); // 0 queue + 1 pending

    // Command finishes, replies enqueued
    dispatcher.sendFinalReply({ text: "Reply 1" });
    dispatcher.sendFinalReply({ text: "Reply 2" });

    // Now: pending=3 (reservation + 2 replies)
    expect(getTotalPendingReplies()).toBe(3);

    // Mark complete (flags reservation for cleanup on last delivery)
    dispatcher.markComplete();

    // Reservation still counted until delivery .finally() clears it,
    // but the important invariant is pending > 0 while deliveries are in flight.
    expect(getTotalPendingReplies()).toBeGreaterThan(0);

    // Wait for replies
    await dispatcher.waitForIdle();

    // Replies sent, pending=0
    expect(getTotalPendingReplies()).toBe(0);
    expect(deliveredReplies).toEqual(["Reply 1", "Reply 2"]);

    // Now everything is idle
    expect(getTotalPendingReplies()).toBe(0);
    expect(getTotalQueueSize()).toBe(0);
  });
});
