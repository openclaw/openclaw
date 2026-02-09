/**
 * This test simulates the ACTUAL async flow where replies are enqueued
 * AFTER dispatchInboundMessage returns (or with a delay).
 * This SHOULD fail and show the bug.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

describe("async reply enqueueing (real production scenario)", () => {
  beforeEach(() => {
    // Clear any state
  });

  afterEach(async () => {
    // Wait for any pending microtasks (from markComplete()) to complete
    await Promise.resolve();
    const { clearAllHandlers } = await import("../channels/inbound-handler-registry.js");
    const { clearAllDispatchers } = await import("../auto-reply/reply/dispatcher-registry.js");
    clearAllHandlers();
    clearAllDispatchers();
  });

  it("SHOULD FAIL: replies enqueued async after dispatchInboundMessage returns", async () => {
    const { registerInboundHandler, getActiveInboundHandlerCount } =
      await import("../channels/inbound-handler-registry.js");
    const { createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js");
    const { getTotalPendingReplies } = await import("../auto-reply/reply/dispatcher-registry.js");

    const events: string[] = [];
    let rpcConnected = true;
    const replyErrors: string[] = [];
    const deliveredReplies: string[] = [];

    // Register handler
    const { unregister } = registerInboundHandler({
      channel: "imessage",
      handlerId: "test",
    });

    // Create dispatcher
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (!rpcConnected) {
          const error = "Error: imsg rpc not running";
          replyErrors.push(error);
          throw new Error(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        deliveredReplies.push(payload.text ?? "");
        events.push(`delivered: ${payload.text}`);
      },
    });

    events.push(
      `initial: handlers=${getActiveInboundHandlerCount()} pending=${getTotalPendingReplies()}`,
    );

    // Simulate dispatchInboundMessage that returns BEFORE replies are enqueued
    const dispatchInboundMessage = async () => {
      events.push("dispatch-start");
      // Simulate async processing
      await new Promise((resolve) => setTimeout(resolve, 100));
      events.push("dispatch-return");
      // Replies will be enqueued AFTER this returns (simulating async agent behavior)
      return { queuedFinal: true };
    };

    // THIS IS THE CRITICAL FLOW - same as production
    const processMessage = async () => {
      await dispatchInboundMessage();
      events.push(`after-dispatch: pending=${getTotalPendingReplies()}`);

      // Wait for idle
      await dispatcher.waitForIdle();
      events.push(`after-waitForIdle: pending=${getTotalPendingReplies()}`);

      // Mark complete
      dispatcher.markComplete();
      events.push(`after-markComplete: pending=${getTotalPendingReplies()}`);
    };

    // Start processing (simulates message handler)
    const messagePromise = processMessage().finally(() => {
      unregister();
      events.push(`handler-unregistered: handlers=${getActiveInboundHandlerCount()}`);
    });

    // Simulate async reply enqueueing that happens AFTER dispatchInboundMessage returns
    const enqueueRepliesAsync = async () => {
      // Wait for dispatch to return
      await new Promise((resolve) => setTimeout(resolve, 150));
      events.push(`enqueuing-reply: pending=${getTotalPendingReplies()}`);
      dispatcher.sendFinalReply({ text: "Reply" });
      events.push(`reply-enqueued: pending=${getTotalPendingReplies()}`);
    };

    // Start async enqueue
    const enqueuePromise = enqueueRepliesAsync();

    // Simulate config change and restart checks
    await new Promise((resolve) => setTimeout(resolve, 200));
    events.push("config-change-detected");

    // Check for restart deferral
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const handlers = getActiveInboundHandlerCount();
      const pending = getTotalPendingReplies();
      const total = handlers + pending;
      events.push(`restart-check-${i}: handlers=${handlers} pending=${pending} total=${total}`);

      if (total === 0) {
        events.push("RESTART-TRIGGERED");
        rpcConnected = false;
        break;
      }
    }

    // Wait for everything to complete
    await Promise.all([messagePromise, enqueuePromise]);

    // Print events
    console.log("\n=== Event Timeline (Async Enqueue Scenario) ===");
    events.forEach((event, i) => console.log(`${i.toString().padStart(2, "0")}: ${event}`));
    console.log("===================\n");

    // ASSERTIONS
    const restartWasTriggered = events.includes("RESTART-TRIGGERED");

    if (restartWasTriggered || replyErrors.length > 0) {
      console.log("\n❌ TEST CAUGHT THE BUG!");
      console.log(`Restart triggered: ${restartWasTriggered}`);
      console.log(`Reply errors: ${replyErrors.length > 0 ? replyErrors.join(", ") : "none yet"}`);
      console.log("This is exactly what happens in production with 'imsg rpc not running'.\n");

      throw new Error(
        "FAILURE: Gateway restarted before reply was sent!\n" +
          "This proves the reservation system doesn't work when replies are enqueued async.",
      );
    }

    // This should NOT have errors or restart
    expect(restartWasTriggered).toBe(false);
    expect(replyErrors).toEqual([]);
    expect(deliveredReplies).toEqual(["Reply"]);
  });
});
