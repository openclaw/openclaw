/**
 * E2E test for config reload during active reply sending.
 * Tests that gateway restart is properly deferred until replies are sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllDispatchers,
  getTotalPendingReplies,
} from "../auto-reply/reply/dispatcher-registry.js";
import {
  clearAllHandlers,
  getActiveInboundHandlerCount,
} from "../channels/inbound-handler-registry.js";

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
    clearAllHandlers();
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

    // Mark dispatcher complete (clears reservation)
    dispatcher.markComplete();

    // Now: pending=1 (just the enqueued reply)
    expect(getTotalPendingReplies()).toBe(1);

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
    expect(getActiveInboundHandlerCount()).toBe(0);
  });

  it("should track active inbound handlers across message lifecycle", async () => {
    const { registerInboundHandler } = await import("../channels/inbound-handler-registry.js");

    // Initially no handlers
    expect(getActiveInboundHandlerCount()).toBe(0);

    // Register handler (simulating message received)
    const { unregister } = registerInboundHandler({
      channel: "imessage",
      handlerId: "test-message-1",
    });

    // Handler is active
    expect(getActiveInboundHandlerCount()).toBe(1);

    // Simulate message processing...
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Handler still active during processing
    expect(getActiveInboundHandlerCount()).toBe(1);

    // Complete message handling
    unregister();

    // Handler no longer active
    expect(getActiveInboundHandlerCount()).toBe(0);
  });

  it("should prevent restart when handler active even if queue empty", async () => {
    const { registerInboundHandler } = await import("../channels/inbound-handler-registry.js");
    const { getTotalQueueSize } = await import("../process/command-queue.js");

    // Register handler
    const { unregister } = registerInboundHandler({
      channel: "imessage",
      handlerId: "test-message-2",
    });

    // Simulate scenario: command finished (queue empty) but handler still processing
    expect(getTotalQueueSize()).toBe(0);
    expect(getActiveInboundHandlerCount()).toBe(1);

    // Total active operations should be > 0 (handler is active)
    const totalActive = getTotalQueueSize() + getActiveInboundHandlerCount();
    expect(totalActive).toBeGreaterThan(0);

    // This should prevent restart
    unregister();
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

    // Now: pending=0 (reservation cleared, no replies were enqueued)
    expect(getTotalPendingReplies()).toBe(0);

    // Wait for idle (should resolve immediately since no replies)
    await dispatcher.waitForIdle();

    expect(deliverCalled).toBe(false);
    expect(getTotalPendingReplies()).toBe(0);
  });

  it("should handle multiple concurrent handlers correctly", async () => {
    const { registerInboundHandler } = await import("../channels/inbound-handler-registry.js");
    const { getActiveHandlersByChannel } = await import("../channels/inbound-handler-registry.js");

    // Register multiple handlers from different channels
    const handler1 = registerInboundHandler({ channel: "imessage", handlerId: "msg1" });
    const handler2 = registerInboundHandler({ channel: "telegram", handlerId: "msg1" });
    const handler3 = registerInboundHandler({ channel: "imessage", handlerId: "msg2" });

    expect(getActiveInboundHandlerCount()).toBe(3);

    const byChannel = getActiveHandlersByChannel();
    expect(byChannel.imessage).toBe(2);
    expect(byChannel.telegram).toBe(1);

    // Unregister one
    handler1.unregister();
    expect(getActiveInboundHandlerCount()).toBe(2);

    // Unregister all
    handler2.unregister();
    handler3.unregister();
    expect(getActiveInboundHandlerCount()).toBe(0);
  });

  it("should integrate dispatcher reservation with handler tracking", async () => {
    const { registerInboundHandler } = await import("../channels/inbound-handler-registry.js");
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalQueueSize } = await import("../process/command-queue.js");

    // Simulate complete message handling flow
    const { unregister: unregisterHandler } = registerInboundHandler({
      channel: "imessage",
      handlerId: "integration-test",
    });

    const deliveredReplies: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        deliveredReplies.push(payload.text ?? "");
      },
    });

    // At this point:
    // - Handler is active (1)
    // - Dispatcher has reservation (pending=1)
    expect(getActiveInboundHandlerCount()).toBe(1);
    expect(getTotalPendingReplies()).toBe(1);

    // Total active = queue + pending + handlers
    const totalActive =
      getTotalQueueSize() + getTotalPendingReplies() + getActiveInboundHandlerCount();
    expect(totalActive).toBe(2); // 0 queue + 1 pending + 1 handler

    // Command finishes, replies enqueued
    dispatcher.sendFinalReply({ text: "Reply 1" });
    dispatcher.sendFinalReply({ text: "Reply 2" });

    // Now: pending=3 (reservation + 2 replies)
    expect(getTotalPendingReplies()).toBe(3);

    // Mark complete (clears reservation)
    dispatcher.markComplete();

    // Now: pending=2 (just the 2 replies)
    expect(getTotalPendingReplies()).toBe(2);

    // Wait for replies
    await dispatcher.waitForIdle();

    // Replies sent, pending=0
    expect(getTotalPendingReplies()).toBe(0);
    expect(deliveredReplies).toEqual(["Reply 1", "Reply 2"]);

    // Unregister handler
    unregisterHandler();

    // Now everything is idle
    expect(getActiveInboundHandlerCount()).toBe(0);
    expect(getTotalPendingReplies()).toBe(0);
    expect(getTotalQueueSize()).toBe(0);
  });
});
