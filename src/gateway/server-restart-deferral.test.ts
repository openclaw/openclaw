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

function holdDelivery() {
  const deliveryStarted = createDeferred();
  const allowDelivery = createDeferred();
  const deliveredReplies: string[] = [];
  const deliver = vi.fn<Parameters<typeof createReplyDispatcher>[0]["deliver"]>(async (payload) => {
    deliveryStarted.resolve();
    await allowDelivery.promise;
    deliveredReplies.push(payload.text ?? "");
  });
  const dispatcher = createReplyDispatcher({ deliver });
  return { dispatcher, deliveryStarted, allowDelivery, deliveredReplies, deliver };
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

  it.each(["before enqueue", "during delivery", "without replies"] as const)(
    "retains the restart reservation %s until completion",
    async (phase) => {
      const { dispatcher, deliveryStarted, allowDelivery, deliveredReplies, deliver } =
        holdDelivery();
      expect(getTotalPendingReplies()).toBe(1);
      await Promise.resolve();
      expect(getTotalPendingReplies()).toBe(1);
      if (phase !== "without replies") {
        dispatcher.sendFinalReply({ text: "Reply" });
        expect(getTotalPendingReplies()).toBe(2);
      }
      dispatcher.markComplete();
      if (phase === "during delivery") {
        await deliveryStarted.promise;
        await flushMicrotasks();
      }
      if (phase === "without replies") {
        await flushMicrotasks();
        expect(getTotalPendingReplies()).toBe(0);
        expect(deliver).not.toHaveBeenCalled();
      } else {
        expect(getTotalPendingReplies()).toBeGreaterThan(0);
      }
      allowDelivery.resolve();
      await dispatcher.waitForIdle();
      expect(getTotalPendingReplies()).toBe(0);
      expect(deliveredReplies).toEqual(phase === "without replies" ? [] : ["Reply"]);
    },
  );
});
