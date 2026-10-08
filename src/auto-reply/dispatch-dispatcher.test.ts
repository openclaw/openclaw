import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  registerReplyDispatcherSettledTask,
  settleReplyDispatcher as settleSourceDispatcher,
} from "./dispatch-dispatcher.js";
import {
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
} from "./reply/reply-dispatcher.js";

it("settles source-owned resources once through a separately loaded SDK after delivery", async () => {
  const entered = createDeferred();
  const delivered = createDeferred();
  const dispatcher = createReplyDispatcher({
    deliver: async () => {
      entered.resolve();
      await delivered.promise;
    },
  });
  let releases = 0;
  registerReplyDispatcherSettledTask(dispatcher, () => {
    releases += 1;
  });
  try {
    expect(dispatcher.sendFinalReply({ text: "Public result" })).toBe(true);
    await entered.promise;
    vi.resetModules();
    const { settleReplyDispatcher } = await import("../plugin-sdk/reply-runtime.js");
    const settled = settleReplyDispatcher({ dispatcher });
    expect(releases).toBe(0);
    delivered.resolve();
    await settled;
    expect(releases).toBe(1);
    await settleReplyDispatcher({ dispatcher });
    expect(releases).toBe(1);
  } finally {
    delivered.resolve();
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
    await sdk.settleReplyDispatcher({ dispatcher });
    await expect(capture.promise).resolves.toBe("delivered");
    expect(attempted).toEqual(["Primary reply", "Known-unsent alternative"]);
  } finally {
    await sdk.settleReplyDispatcher({ dispatcher });
  }
});
