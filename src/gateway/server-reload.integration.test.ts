/**
 * Integration test simulating full message handling + config change + reply flow.
 * This tests the complete scenario where a user configures an adapter via chat
 * and ensures they get a reply before the gateway restarts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("gateway restart deferral integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Wait for any pending microtasks (from markComplete()) to complete
    await Promise.resolve();
    const { clearAllDispatchers } = await import("../auto-reply/reply/dispatcher-registry.js");
    clearAllDispatchers();
  });

  it("should defer restart until dispatcher completes with reply", async () => {
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalPendingReplies } = await import("../auto-reply/reply/dispatcher-registry.js");
    const { getTotalQueueSize } = await import("../process/command-queue.js");

    const events: string[] = [];

    // T=0: Message received — dispatcher created (pending=1 reservation)
    events.push("message-received");
    const deliveredReplies: Array<{ text: string; timestamp: number }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        // Simulate network delay
        await new Promise((resolve) => setTimeout(resolve, 20));
        deliveredReplies.push({
          text: payload.text ?? "",
          timestamp: Date.now(),
        });
        events.push(`reply-delivered: ${payload.text}`);
      },
    });
    events.push("dispatcher-created");

    // T=1: Config change detected
    events.push("config-change-detected");

    // Check if restart should be deferred
    const queueSize = getTotalQueueSize();
    const pendingReplies = getTotalPendingReplies();
    const totalActive = queueSize + pendingReplies;

    events.push(`defer-check: queue=${queueSize} pending=${pendingReplies} total=${totalActive}`);

    // Should defer because dispatcher has reservation
    expect(totalActive).toBeGreaterThan(0);
    expect(pendingReplies).toBe(1); // reservation

    if (totalActive > 0) {
      events.push("restart-deferred");
    }

    // T=2: Command finishes, enqueue replies
    dispatcher.sendFinalReply({ text: "Adapter configured successfully!" });
    dispatcher.sendFinalReply({ text: "Gateway will restart to apply changes." });
    events.push("replies-enqueued");

    // Now pending should be 3 (reservation + 2 replies)
    expect(getTotalPendingReplies()).toBe(3);

    // Mark command complete (flags reservation for cleanup on last delivery)
    dispatcher.markComplete();
    events.push("command-complete");

    // Reservation still counted until delivery .finally() clears it,
    // but the important invariant is pending > 0 while deliveries are in flight.
    expect(getTotalPendingReplies()).toBeGreaterThan(0);

    // T=3: Wait for replies to be delivered
    await dispatcher.waitForIdle();
    events.push("dispatcher-idle");

    // Replies should be delivered
    expect(deliveredReplies).toHaveLength(2);
    expect(deliveredReplies[0].text).toBe("Adapter configured successfully!");
    expect(deliveredReplies[1].text).toBe("Gateway will restart to apply changes.");

    // Pending should be 0
    expect(getTotalPendingReplies()).toBe(0);

    // T=4: Check if restart can proceed
    const finalQueueSize = getTotalQueueSize();
    const finalPendingReplies = getTotalPendingReplies();
    const finalTotalActive = finalQueueSize + finalPendingReplies;

    events.push(
      `restart-check: queue=${finalQueueSize} pending=${finalPendingReplies} total=${finalTotalActive}`,
    );

    // Everything should be idle now
    expect(finalTotalActive).toBe(0);
    events.push("restart-can-proceed");

    // Verify event sequence
    expect(events).toEqual([
      "message-received",
      "dispatcher-created",
      "config-change-detected",
      "defer-check: queue=0 pending=1 total=1",
      "restart-deferred",
      "replies-enqueued",
      "command-complete",
      "reply-delivered: Adapter configured successfully!",
      "reply-delivered: Gateway will restart to apply changes.",
      "dispatcher-idle",
      "restart-check: queue=0 pending=0 total=0",
      "restart-can-proceed",
    ]);
  });
});
