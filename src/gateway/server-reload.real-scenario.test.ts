/**
 * REAL scenario test - simulates actual message handling with config changes.
 * This test MUST fail if "imsg rpc not running" would occur in production.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("real scenario: config change during message processing", () => {
  let replyErrors: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    replyErrors = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Wait for any pending microtasks (from markComplete()) to complete
    await Promise.resolve();
    const { clearAllDispatchers } = await import("../auto-reply/reply/dispatcher-registry.js");
    clearAllDispatchers();
  });

  it("should NOT restart gateway while reply delivery is in flight", async () => {
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalPendingReplies } = await import("../auto-reply/reply/dispatcher-registry.js");

    let rpcConnected = true;
    const deliveredReplies: string[] = [];

    // Create dispatcher with slow delivery (simulates real network delay)
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (!rpcConnected) {
          const error = "Error: imsg rpc not running";
          replyErrors.push(error);
          throw new Error(error);
        }
        // Slow delivery — restart checks will run during this window
        await new Promise((resolve) => setTimeout(resolve, 150));
        deliveredReplies.push(payload.text ?? "");
      },
      onError: () => {
        // Swallow delivery errors so the test can assert on replyErrors
      },
    });

    // Enqueue reply and immediately clear the reservation.
    // This is the critical sequence: after markComplete(), the ONLY thing
    // keeping pending > 0 is the in-flight delivery itself.
    dispatcher.sendFinalReply({ text: "Configuration updated!" });
    dispatcher.markComplete();

    // At this point: markComplete flagged, delivery is in flight.
    // pending > 0 because the in-flight delivery keeps it alive.
    const pendingDuringDelivery = getTotalPendingReplies();
    expect(pendingDuringDelivery).toBeGreaterThan(0);

    // Simulate restart checks while delivery is in progress.
    // If the tracking is broken, pending would be 0 and we'd restart.
    let restartTriggered = false;
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const pending = getTotalPendingReplies();
      if (pending === 0) {
        restartTriggered = true;
        rpcConnected = false;
        break;
      }
    }

    // Wait for delivery to complete
    await dispatcher.waitForIdle();

    // Now pending should be 0 — restart can proceed
    expect(getTotalPendingReplies()).toBe(0);

    // CRITICAL: delivery must have succeeded without RPC being killed
    expect(restartTriggered).toBe(false);
    expect(replyErrors).toEqual([]);
    expect(deliveredReplies).toEqual(["Configuration updated!"]);
  });

  it("should keep pending > 0 until reply is actually enqueued", async () => {
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalPendingReplies } = await import("../auto-reply/reply/dispatcher-registry.js");

    const dispatcher = createReplyDispatcher({
      deliver: async (_payload) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });

    // Initially: pending=1 (reservation)
    expect(getTotalPendingReplies()).toBe(1);

    // Simulate command processing delay BEFORE reply is enqueued
    await new Promise((resolve) => setTimeout(resolve, 20));

    // During this delay, pending should STILL be 1 (reservation active)
    expect(getTotalPendingReplies()).toBe(1);

    // Now enqueue reply
    dispatcher.sendFinalReply({ text: "Reply" });

    // Now pending should be 2 (reservation + reply)
    expect(getTotalPendingReplies()).toBe(2);

    // Mark complete
    dispatcher.markComplete();

    // After markComplete, pending should still be > 0 if reply hasn't sent yet
    const pendingAfterMarkComplete = getTotalPendingReplies();
    expect(pendingAfterMarkComplete).toBeGreaterThan(0);

    // Wait for reply to send
    await dispatcher.waitForIdle();

    // Now pending should be 0
    expect(getTotalPendingReplies()).toBe(0);
  });
});
