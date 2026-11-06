import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  registerReplyDispatcherSettledTask,
  settleReplyDispatcher as settleSourceDispatcher,
  waitForReplyDispatcherSettlement,
} from "./dispatch-dispatcher.js";
import {
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
} from "./reply/reply-dispatcher.js";

it("joins delivery and source-owned cleanup across SDK graphs without running it from the waiter", async () => {
  const deliveryEntered = createDeferred();
  const delivered = createDeferred();
  const entered = createDeferred();
  const release = createDeferred();
  const failure = new Error("recording failed");
  const dispatcher = createReplyDispatcher({
    deliver: async () => {
      deliveryEntered.resolve();
      await delivered.promise;
    },
  });
  const calls: string[] = [];
  registerReplyDispatcherSettledTask(dispatcher, async () => {
    calls.push("recording");
    entered.resolve();
    await release.promise;
    throw failure;
  });
  registerReplyDispatcherSettledTask(dispatcher, () => {
    calls.push("cleanup");
  });
  let ownerSettled = false;
  const owner = waitForReplyDispatcherSettlement(dispatcher).then(() => {
    ownerSettled = true;
  });
  try {
    expect(dispatcher.sendFinalReply({ text: "Public result" })).toBe(true);
    await deliveryEntered.promise;
    vi.resetModules();
    const { settleReplyDispatcher } = await import("../plugin-sdk/reply-runtime.js");
    const rejected = expect(settleSourceDispatcher({ dispatcher })).rejects.toBe(failure);
    const concurrent = expect(settleReplyDispatcher({ dispatcher })).rejects.toBe(failure);
    expect(calls).toEqual([]);
    delivered.resolve();
    await entered.promise;
    expect(ownerSettled).toBe(false);
    release.resolve();
    await Promise.all([rejected, concurrent, owner]);
    await settleReplyDispatcher({ dispatcher });
    expect(calls).toEqual(["recording", "cleanup"]);
  } finally {
    delivered.resolve();
    release.resolve();
    await settleSourceDispatcher({ dispatcher });
  }
});

it("observes the SDK enqueue and sends a source-owned alternative only after proven non-delivery", async () => {
  const payload = { text: "Primary reply" };
  const capture = captureReplyDispatchDeliveryOutcome(payload);
  attachReplyDispatchUndeliveredFallback(payload, { text: "Known-unsent alternative" });
  vi.resetModules();
  const sdk = await import("../plugin-sdk/reply-runtime.js");
  const attempted: string[] = [];
  const dispatcher = sdk.createReplyDispatcher({
    deliver: async (reply) => {
      attempted.push(reply.text ?? "");
      return reply.text === payload.text
        ? { visibleReplySent: false, suppression: { reason: "no_visible_result" } }
        : { visibleReplySent: true };
    },
  });
  try {
    expect(dispatcher.sendFinalReply(payload)).toBe(true);
    expect(capture.isTracked()).toBe(true);
  } finally {
    await sdk.settleReplyDispatcher({ dispatcher });
  }
  await expect(capture.promise).resolves.toBe("delivered");
  expect(attempted).toEqual(["Primary reply", "Known-unsent alternative"]);
});
