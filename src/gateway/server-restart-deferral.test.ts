// Restart deferral tests protect queue-depth checks that delay gateway restart
// until in-flight reply deliveries and command work have drained.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";

async function flushMicrotasks(count = 10): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

describe("gateway restart deferral", () => {
  beforeEach(() => {
    resetCommandQueueStateForTest();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await flushMicrotasks();
    expect(getTotalPendingReplies()).toBe(0);
    resetCommandQueueStateForTest();
  });

  it("defers restart while reply delivery is in flight", async () => {
    const deliveredReplies: string[] = [];
    const deliveryStarted = createDeferred();
    const allowDelivery = createDeferred();

    // Hold delivery open so restart checks run while reply is in-flight.
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        deliveryStarted.resolve();
        await allowDelivery.promise;
        deliveredReplies.push(payload.text ?? "");
      },
    });

    // Completing the producer must retain its in-flight delivery reservation.
    dispatcher.sendFinalReply({ text: "Configuration updated!" });
    dispatcher.markComplete();
    await deliveryStarted.promise;
    await flushMicrotasks();

    // At this point: delivery is in flight; pending > 0 prevents restart.
    expect(getTotalPendingReplies()).toBeGreaterThan(0);

    allowDelivery.resolve();
    await dispatcher.waitForIdle();

    expect(getTotalPendingReplies()).toBe(0);
    expect(deliveredReplies).toEqual(["Configuration updated!"]);
  });

  it("keeps pending > 0 until the reply is actually enqueued", async () => {
    const allowDelivery = createDeferred();

    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        await allowDelivery.promise;
      },
    });

    expect(getTotalPendingReplies()).toBe(1);

    await Promise.resolve();
    expect(getTotalPendingReplies()).toBe(1);

    dispatcher.sendFinalReply({ text: "Reply" });
    expect(getTotalPendingReplies()).toBe(2);

    dispatcher.markComplete();
    expect(getTotalPendingReplies()).toBeGreaterThan(0);

    allowDelivery.resolve();
    await dispatcher.waitForIdle();
    expect(getTotalPendingReplies()).toBe(0);
  });

  it("clears dispatcher reservation when no replies were sent", async () => {
    let deliverCalled = false;
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        deliverCalled = true;
      },
    });

    expect(getTotalPendingReplies()).toBe(1);

    dispatcher.markComplete();
    await flushMicrotasks();

    expect(getTotalPendingReplies()).toBe(0);
    await dispatcher.waitForIdle();

    expect(deliverCalled).toBe(false);
    expect(getTotalPendingReplies()).toBe(0);
  });
});
