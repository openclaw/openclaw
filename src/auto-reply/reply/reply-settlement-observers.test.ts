import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { getTotalPendingReplies } from "./dispatcher-registry.js";
import { captureReplyDispatchDeliveryOutcome, createReplyDispatcher } from "./reply-dispatcher.js";

describe("reply settlement observer isolation", () => {
  it.each([false, true])(
    "settles every reply when the observer and its error reporter fail (async=%s)",
    async (asyncReporter) => {
      const initialPending = getTotalPendingReplies();
      const observerFailure = new Error("settlement observer failed");
      const reportFailure = new Error("error reporter failed");
      const onError = vi.fn(() => {
        if (asyncReporter) {
          return Promise.reject(reportFailure);
        }
        throw reportFailure;
      });
      const onIdle = vi.fn();
      const onDeliverySettled = vi.fn(() => {
        throw observerFailure;
      });
      const deliver = vi.fn<Parameters<typeof createReplyDispatcher>[0]["deliver"]>(async () => ({
        visibleReplySent: true,
      }));
      const dispatcher = createReplyDispatcher({ deliver, onError, onIdle, onDeliverySettled });
      const first = { text: "First reply" };
      const last = { text: "Final reply" };
      const firstOutcome = captureReplyDispatchDeliveryOutcome(first);
      const lastOutcome = captureReplyDispatchDeliveryOutcome(last);
      dispatcher.sendBlockReply(first);
      dispatcher.sendFinalReply(last);
      dispatcher.markComplete();

      await expect(dispatcher.waitForIdle()).resolves.toMatchObject({
        anyVisibleDelivered: true,
        counts: { block: { delivered: 1 }, final: { delivered: 1 } },
      });
      await expect(firstOutcome.promise).resolves.toBe("delivered");
      await expect(lastOutcome.promise).resolves.toBe("delivered");
      expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual([
        "First reply",
        "Final reply",
      ]);
      expect(onDeliverySettled).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenNthCalledWith(1, observerFailure, { kind: "block" });
      expect(onError).toHaveBeenNthCalledWith(2, observerFailure, { kind: "final" });
      expect(onIdle).toHaveBeenCalledOnce();
      expect(onError.mock.invocationCallOrder[1]).toBeLessThan(
        expectDefined(onIdle.mock.invocationCallOrder[0], "idle callback order"),
      );
      expect(getTotalPendingReplies()).toBe(initialPending);
    },
  );

  it("retains cancellation when its observer and error reporter throw", async () => {
    const initialPending = getTotalPendingReplies();
    const observerFailure = new Error("cancellation observer failed");
    const onError = vi.fn(() => {
      throw new Error("error reporter failed");
    });
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: () => null,
      onBeforeDeliverCancelled: () => {
        throw observerFailure;
      },
      onError,
    });
    dispatcher.sendFinalReply({ text: "Cancelled reply" });
    dispatcher.markComplete();

    await expect(dispatcher.waitForIdle()).resolves.toMatchObject({
      anyVisibleDelivered: false,
      counts: { final: { cancelled: 1, failedBeforeSend: 0 } },
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(observerFailure, { kind: "final" });
    expect(getTotalPendingReplies()).toBe(initialPending);
  });
});
