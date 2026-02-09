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
    const { clearAllHandlers } = await import("../channels/inbound-handler-registry.js");
    const { clearAllDispatchers } = await import("../auto-reply/reply/dispatcher-registry.js");
    clearAllHandlers();
    clearAllDispatchers();
  });

  it("should defer restart until message handler completes with reply", async () => {
    const { registerInboundHandler, getActiveInboundHandlerCount } =
      await import("../channels/inbound-handler-registry.js");
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalPendingReplies } = await import("../auto-reply/reply/dispatcher-registry.js");
    const { getTotalQueueSize } = await import("../process/command-queue.js");

    // Timeline of events:
    // T=0: Message received, handler registered
    // T=1: Command executing
    // T=2: Config change detected
    // T=3: Command finishes, replies enqueued
    // T=4: Replies sent
    // T=5: Handler completes
    // T=6: Restart proceeds

    const events: string[] = [];

    // T=0: Message received
    events.push("message-received");
    const { unregister: unregisterHandler } = registerInboundHandler({
      channel: "imessage",
      handlerId: "test-msg-1",
    });
    events.push("handler-registered");

    // T=1: Create dispatcher (command will execute)
    const deliveredReplies: Array<{ text: string; timestamp: number }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        // Simulate network delay
        await new Promise((resolve) => setTimeout(resolve, 100));
        deliveredReplies.push({
          text: payload.text ?? "",
          timestamp: Date.now(),
        });
        events.push(`reply-delivered: ${payload.text}`);
      },
    });
    events.push("dispatcher-created");

    // T=2: Config change detected (simulated)
    events.push("config-change-detected");

    // Check if restart should be deferred
    const queueSize = getTotalQueueSize();
    const pendingReplies = getTotalPendingReplies();
    const activeHandlers = getActiveInboundHandlerCount();
    const totalActive = queueSize + pendingReplies + activeHandlers;

    events.push(
      `defer-check: queue=${queueSize} pending=${pendingReplies} handlers=${activeHandlers} total=${totalActive}`,
    );

    // Should defer because handler is active and dispatcher has reservation
    expect(totalActive).toBeGreaterThan(0);
    expect(activeHandlers).toBe(1);
    expect(pendingReplies).toBe(1); // reservation

    if (totalActive > 0) {
      events.push("restart-deferred");
    }

    // T=3: Command finishes, enqueue replies
    dispatcher.sendFinalReply({ text: "Adapter configured successfully!" });
    dispatcher.sendFinalReply({ text: "Gateway will restart to apply changes." });
    events.push("replies-enqueued");

    // Now pending should be 3 (reservation + 2 replies)
    expect(getTotalPendingReplies()).toBe(3);

    // Mark command complete
    dispatcher.markComplete();
    events.push("command-complete");

    // Now pending should be 2 (just the 2 replies)
    expect(getTotalPendingReplies()).toBe(2);

    // T=4: Wait for replies to be delivered
    await dispatcher.waitForIdle();
    events.push("dispatcher-idle");

    // Replies should be delivered
    expect(deliveredReplies).toHaveLength(2);
    expect(deliveredReplies[0].text).toBe("Adapter configured successfully!");
    expect(deliveredReplies[1].text).toBe("Gateway will restart to apply changes.");

    // Pending should be 0
    expect(getTotalPendingReplies()).toBe(0);

    // T=5: Handler completes
    unregisterHandler();
    events.push("handler-complete");

    // T=6: Check if restart can proceed
    const finalQueueSize = getTotalQueueSize();
    const finalPendingReplies = getTotalPendingReplies();
    const finalActiveHandlers = getActiveInboundHandlerCount();
    const finalTotalActive = finalQueueSize + finalPendingReplies + finalActiveHandlers;

    events.push(
      `restart-check: queue=${finalQueueSize} pending=${finalPendingReplies} handlers=${finalActiveHandlers} total=${finalTotalActive}`,
    );

    // Everything should be idle now
    expect(finalTotalActive).toBe(0);
    events.push("restart-can-proceed");

    // Verify event sequence
    expect(events).toEqual([
      "message-received",
      "handler-registered",
      "dispatcher-created",
      "config-change-detected",
      "defer-check: queue=0 pending=1 handlers=1 total=2",
      "restart-deferred",
      "replies-enqueued",
      "command-complete",
      "reply-delivered: Adapter configured successfully!",
      "reply-delivered: Gateway will restart to apply changes.",
      "dispatcher-idle",
      "handler-complete",
      "restart-check: queue=0 pending=0 handlers=0 total=0",
      "restart-can-proceed",
    ]);
  });

  it("should handle concurrent messages with config changes", async () => {
    const { registerInboundHandler, getActiveInboundHandlerCount } =
      await import("../channels/inbound-handler-registry.js");
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalPendingReplies } = await import("../auto-reply/reply/dispatcher-registry.js");

    // Simulate two messages being processed concurrently
    const deliveredReplies: string[] = [];

    // Message 1
    const handler1 = registerInboundHandler({
      channel: "imessage",
      handlerId: "msg1",
    });

    const dispatcher1 = createReplyDispatcher({
      deliver: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        deliveredReplies.push(`msg1: ${payload.text}`);
      },
    });

    // Message 2
    const handler2 = registerInboundHandler({
      channel: "telegram",
      handlerId: "msg2",
    });

    const dispatcher2 = createReplyDispatcher({
      deliver: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        deliveredReplies.push(`msg2: ${payload.text}`);
      },
    });

    // Both handlers active
    expect(getActiveInboundHandlerCount()).toBe(2);

    // Both dispatchers have reservations
    expect(getTotalPendingReplies()).toBe(2);

    // Config change detected - should defer
    const totalActive = getTotalPendingReplies() + getActiveInboundHandlerCount();
    expect(totalActive).toBe(4); // 2 dispatchers + 2 handlers

    // Messages process and send replies
    dispatcher1.sendFinalReply({ text: "Reply from message 1" });
    dispatcher1.markComplete();

    dispatcher2.sendFinalReply({ text: "Reply from message 2" });
    dispatcher2.markComplete();

    // Wait for both
    await Promise.all([dispatcher1.waitForIdle(), dispatcher2.waitForIdle()]);

    // Complete handlers
    handler1.unregister();
    handler2.unregister();

    // All idle
    expect(getActiveInboundHandlerCount()).toBe(0);
    expect(getTotalPendingReplies()).toBe(0);

    // Replies delivered
    expect(deliveredReplies).toHaveLength(2);
  });

  it("should handle rapid config changes without losing replies", async () => {
    const { registerInboundHandler } = await import("../channels/inbound-handler-registry.js");
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalPendingReplies } = await import("../auto-reply/reply/dispatcher-registry.js");

    const deliveredReplies: string[] = [];

    // Message received
    const { unregister } = registerInboundHandler({
      channel: "imessage",
      handlerId: "rapid-test",
    });

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 200)); // Slow network
        deliveredReplies.push(payload.text ?? "");
      },
    });

    // Config change 1
    // Config change 2
    // Config change 3 (rapid changes)
    // All should be deferred because handler is active

    // Send replies
    dispatcher.sendFinalReply({ text: "Processing..." });
    dispatcher.sendFinalReply({ text: "Almost done..." });
    dispatcher.sendFinalReply({ text: "Complete!" });
    dispatcher.markComplete();

    // Wait for all replies
    await dispatcher.waitForIdle();

    // All replies should be delivered
    expect(deliveredReplies).toEqual(["Processing...", "Almost done...", "Complete!"]);

    unregister();

    // Now restart can proceed
    expect(getTotalPendingReplies()).toBe(0);
  });
});
