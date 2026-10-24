import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { getTotalPendingReplies } from "./dispatcher-registry.js";
import {
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
} from "./reply-dispatcher.js";

describe("reply settlement observer isolation", () => {
  it.each([
    { asyncObserver: false, asyncReporter: false },
    { asyncObserver: true, asyncReporter: true },
  ])(
    "settles replies independently of observer failure (asyncObserver=$asyncObserver, asyncReporter=$asyncReporter)",
    async ({ asyncObserver, asyncReporter }) => {
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
      const onDeliverySettled =
        vi.fn<NonNullable<Parameters<typeof createReplyDispatcher>[0]["onDeliverySettled"]>>();
      if (asyncObserver) {
        onDeliverySettled.mockRejectedValue(observerFailure);
      } else {
        onDeliverySettled.mockImplementation(() => {
          throw observerFailure;
        });
      }
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
      expect(onIdle).toHaveBeenCalledOnce();
      expect(getTotalPendingReplies()).toBe(initialPending);
      expect(onError).toHaveBeenNthCalledWith(1, observerFailure, { kind: "block" });
      expect(onError).toHaveBeenNthCalledWith(2, observerFailure, { kind: "final" });
      if (!asyncObserver) {
        expect(onError.mock.invocationCallOrder[1]).toBeLessThan(
          expectDefined(onIdle.mock.invocationCallOrder[0], "idle callback order"),
        );
      }
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

  it("logs an idle observer failure and still runs settlement cleanup", async () => {
    const warnings = createWarnLogCapture("reply-dispatcher-idle-observer");
    try {
      const secret = "sk-idleobserversecret1234567890abcdef"; // pragma: allowlist secret
      const observerFailure = new Error("idle observer failed");
      observerFailure.stack = `Error: idle observer failed\n    at observer-stack-frame (Authorization: Bearer ${secret})`;
      const onSettled = vi.fn();
      const { dispatcher } = createReplyDispatcherWithTyping({
        deliver: async () => ({ visibleReplySent: true }),
        onIdle: () => {
          throw observerFailure;
        },
        onSettled,
      });

      dispatcher.sendFinalReply({ text: "Final reply" });
      dispatcher.markComplete();

      await expect(dispatcher.waitForIdle()).resolves.toMatchObject({
        anyVisibleDelivered: true,
        counts: { final: { delivered: 1 } },
      });
      await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
      await expect(warnings.findText(observerFailure.message)).resolves.toBeDefined();
      await expect(warnings.findText("observer-stack-frame")).resolves.toBeDefined();
      await expect(warnings.findText(secret)).resolves.toBeUndefined();
    } finally {
      warnings.cleanup();
    }
  });

  it("logs a failed error reporter instead of dropping the observer failure", async () => {
    const warnings = createWarnLogCapture("reply-dispatcher-error-observer");
    try {
      const reporterFailure = new Error("error reporter failed");
      const deliveryFailure = new Error("delivery failed");
      const dispatcher = createReplyDispatcher({
        deliver: async () => {
          throw deliveryFailure;
        },
        onError: () => {
          throw reporterFailure;
        },
      });

      dispatcher.sendFinalReply({ text: "Final reply" });
      dispatcher.markComplete();

      await dispatcher.waitForIdle();
      await expect(warnings.findText(reporterFailure.message)).resolves.toBeDefined();
    } finally {
      warnings.cleanup();
    }
  });
});
