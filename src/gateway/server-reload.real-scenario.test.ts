/**
 * REAL scenario test - simulates actual message handling with config changes.
 * This test MUST fail if "imsg rpc not running" would occur in production.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  clearAllDispatchers,
  getTotalPendingReplies,
} from "../auto-reply/reply/dispatcher-registry.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    clearAllDispatchers();
  });

  it("should NOT restart gateway while reply delivery is in flight", async () => {
    let rpcConnected = true;
    const deliveredReplies: string[] = [];
    const deliveryStarted = createDeferred();
    const allowDelivery = createDeferred();

    // Hold delivery open so restart checks run while reply is in-flight.
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (!rpcConnected) {
          const error = "Error: imsg rpc not running";
          replyErrors.push(error);
          throw new Error(error);
        }
        deliveryStarted.resolve();
        await allowDelivery.promise;
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
    await deliveryStarted.promise;

    // At this point: markComplete flagged, delivery is in flight.
    // pending > 0 because the in-flight delivery keeps it alive.
    const pendingDuringDelivery = getTotalPendingReplies();
    expect(pendingDuringDelivery).toBeGreaterThan(0);

    // Simulate restart checks while delivery is in progress.
    // If the tracking is broken, pending would be 0 and we'd restart.
    let restartTriggered = false;
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      const pending = getTotalPendingReplies();
      if (pending === 0) {
        restartTriggered = true;
        rpcConnected = false;
        break;
      }
    }

    allowDelivery.resolve();
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
    const allowDelivery = createDeferred();

    const dispatcher = createReplyDispatcher({
      deliver: async (_payload) => {
        await allowDelivery.promise;
      },
    });

    // Initially: pending=1 (reservation)
    expect(getTotalPendingReplies()).toBe(1);

    // Simulate command processing delay BEFORE reply is enqueued
    await Promise.resolve();

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

    allowDelivery.resolve();
    // Wait for reply to send
    await dispatcher.waitForIdle();

    // Now pending should be 0
    expect(getTotalPendingReplies()).toBe(0);
  });
});
