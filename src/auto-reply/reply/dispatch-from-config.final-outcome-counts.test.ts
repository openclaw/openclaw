import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import {
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
  type ReplyDispatcherOptions,
} from "./reply-dispatcher.js";

const visible = { visibleReplySent: true };
const hidden = { visibleReplySent: false };

function deliveryHarness(
  results: unknown[],
  options: Omit<ReplyDispatcherOptions, "deliver"> = {},
) {
  const attempts: string[] = [];
  const dispatcher = createReplyDispatcher({
    ...options,
    deliver: async (payload) => {
      attempts.push(payload.text ?? "");
      if (!results.length) {
        throw new Error("Unexpected delivery attempt");
      }
      const result = results.shift();
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  });
  return { dispatcher, attempts, ledger: createReplyTurnLedger(dispatcher) };
}

function fallbackPayload() {
  const payload = { text: "primary" };
  attachReplyDispatchUndeliveredFallback(payload, { text: "alternative" });
  return payload;
}

function noSendError(message = "offline before dispatch") {
  return new PlatformMessageNotDispatchedError(message, { cause: new Error("offline") });
}

function recoveryError(cause: Error, queueCustody: "held" | "released" = "held") {
  return Object.assign(new OutboundDeliveryError("queued", { cause }), { queueCustody });
}

function settle(dispatcher: ReturnType<typeof createReplyDispatcher>) {
  dispatcher.markComplete();
  return dispatcher.waitForIdle();
}

describe("settled dispatcher final outcomes", () => {
  it.each([false, true])("keeps identityless delivery pending (deferred=%s)", async (deferred) => {
    const uncertain = {
      visibleReplySent: true,
      suppression: { reason: "adapter_returned_no_identity" },
    };
    const payload = fallbackPayload();
    const capture = captureReplyDispatchDeliveryOutcome(payload);
    const { dispatcher, attempts } = deliveryHarness([
      deferred ? { finalization: Promise.resolve(uncertain) } : uncertain,
    ]);
    dispatcher.sendFinalReply(payload);
    const receipt = await settle(dispatcher);

    expect(attempts).toEqual(["primary"]);
    expect(receipt).toMatchObject({
      anyVisibleDelivered: false,
      hasPendingDelivery: true,
      counts: { final: { delivered: 0, deliveredNotVisible: 1 } },
    });
    await expect(capture.promise).resolves.toBe("delivered-not-visible");
    expect(capture.hasPendingDelivery()).toBe(true);
  });

  it.each(["channel_transform", "no_visible_result"])(
    "keeps %s suppression and immediate fallback order",
    async (reason) => {
      const payload = fallbackPayload();
      const outcome = captureReplyDispatchDeliveryOutcome(payload);
      const { dispatcher, ledger, attempts } = deliveryHarness([
        { ...hidden, suppression: { reason } },
        visible,
        visible,
      ]);
      const send = ledger.sendQueued("final", payload);
      const second = ledger.sendQueued("final", { text: "second final" });
      expect(send.queued).toBe(true);
      expect(outcome.isTracked()).toBe(true);
      const receipt = await settle(dispatcher);

      const suppressed = reason === "channel_transform";
      expect(attempts).toEqual(
        suppressed ? ["primary", "second final"] : ["primary", "alternative", "second final"],
      );
      const firstOutcome = suppressed ? "channel-transform" : "delivered";
      await expect(Promise.all([outcome.promise, send.outcome, second.outcome])).resolves.toEqual([
        firstOutcome,
        firstOutcome,
        "delivered",
      ]);
      expect(receipt).toMatchObject({
        anyVisibleDelivered: true,
        counts: {
          final: {
            delivered: suppressed ? 1 : 2,
            deliveredNotVisible: suppressed ? 1 : 0,
          },
        },
      });
    },
  );

  it("drains later finals before flushing a deferred delivery and its alternative", async () => {
    const finalized = createDeferred<{ visibleReplySent: boolean }>();
    const payload = fallbackPayload();
    const { dispatcher, attempts, ledger } = deliveryHarness(
      [{ ...hidden, finalization: finalized.promise }, visible, visible],
      {
        onIdle: () => {
          expect(attempts).toContain("second final");
          finalized.resolve({ visibleReplySent: false });
        },
      },
    );
    const first = ledger.sendQueued("final", payload);
    const second = ledger.sendQueued("final", { text: "second final" });
    const receipt = await settle(dispatcher);

    expect(attempts).toEqual(["primary", "second final", "alternative"]);
    await expect(Promise.all([first.outcome, second.outcome])).resolves.toEqual([
      "delivered",
      "delivered",
    ]);
    expect(receipt?.counts.final.delivered).toBe(2);
  });

  it.each([false, true])("isolates reused payload receipts (recovery=%s)", async (recovery) => {
    const error = recoveryError(
      new PlatformMessageNotDispatchedError("offline", { cause: undefined }),
    );
    const { dispatcher, ledger } = deliveryHarness(
      recovery ? [error, undefined] : [visible, hidden],
    );
    const payload = { text: "same object" };
    const first = captureReplyDispatchDeliveryOutcome(payload);
    const nested = captureReplyDispatchDeliveryOutcome(payload);
    const firstSend = ledger.sendQueued(recovery ? "block" : "final", payload);
    const next = captureReplyDispatchDeliveryOutcome(payload);
    const firstOutcome = recovery ? "recovery-owned" : "delivered";
    await expect(firstSend.outcome).resolves.toBe(firstOutcome);
    const secondSend = ledger.sendQueued("final", payload);
    expect(next.isTracked()).toBe(true);
    const receipt = await settle(dispatcher);
    const secondOutcome = recovery ? "delivered" : "delivered-not-visible";
    await expect(
      Promise.all([first.promise, nested.promise, next.promise, secondSend.outcome]),
    ).resolves.toEqual([firstOutcome, firstOutcome, secondOutcome, secondOutcome]);
    expect([
      first.hasPendingDelivery(),
      nested.hasPendingDelivery(),
      firstSend.hasPendingDelivery?.(),
      next.hasPendingDelivery(),
      secondSend.hasPendingDelivery?.(),
    ]).toEqual([recovery, recovery, recovery, false, false]);
    if (!recovery) {
      expect(receipt?.counts.final).toMatchObject({ delivered: 1, deliveredNotVisible: 1 });
    }
  });

  it.each(["caller-first", "recovery-first", "attached-fallback"] as const)(
    "keeps recovery exclusive across %s attempts",
    async (order) => {
      const noSend = noSendError("not dispatched");
      const recovery = recoveryError(noSend);
      const { dispatcher, ledger, attempts } = deliveryHarness(
        order === "recovery-first" ? [recovery, noSend] : [noSend, recovery],
        { propagateRetryableNoSendFailure: true },
      );
      const callerPayload = { text: "caller" };
      const recoveryPayload = { text: "recovery" };
      const payloads =
        order === "recovery-first"
          ? [recoveryPayload, callerPayload]
          : [callerPayload, recoveryPayload];
      if (order === "attached-fallback") {
        attachReplyDispatchUndeliveredFallback(callerPayload, recoveryPayload);
        payloads.pop();
      }
      const outcomes = payloads.map((payload) =>
        Promise.resolve(ledger.sendQueued("final", payload).outcome),
      );
      const receipt = await settle(dispatcher);

      expect(attempts).toEqual(
        order === "recovery-first" ? ["recovery", "caller"] : ["caller", "recovery"],
      );
      expect(await Promise.all(outcomes)).toEqual(
        order === "attached-fallback"
          ? ["recovery-owned"]
          : order === "recovery-first"
            ? ["recovery-owned", "failed-before-deliver"]
            : ["failed-before-deliver", "recovery-owned"],
      );
      expect(receipt?.counts.final).toEqual({
        delivered: 0,
        deliveredNotVisible: 0,
        cancelled: 0,
        failedBeforeSend: payloads.length,
        failedAfterSend: 0,
      });
      expect(receipt?.anyVisibleDelivered).toBe(false);
      expect(ledger.canAttemptFallback()).toBe(false);
      expect(ledger.hasObservedDelivery()).toBe(false);
    },
  );

  it("keeps non-visible, pre-send, and post-send outcomes distinct", async () => {
    const { dispatcher, attempts } = deliveryHarness([
      hidden,
      Object.assign(new Error("connect failed"), { code: "ECONNREFUSED", syscall: "connect" }),
      new Error("send outcome unknown"),
    ]);

    dispatcher.sendToolResult({ text: "hidden" });
    dispatcher.sendBlockReply({ text: "never sent" });
    dispatcher.sendFinalReply({ text: "maybe sent" });
    const receipt = await settle(dispatcher);
    expect(attempts).toEqual(["hidden", "never sent", "maybe sent"]);

    expect(receipt).toMatchObject({
      counts: {
        tool: { deliveredNotVisible: 1 },
        block: { failedBeforeSend: 1 },
        final: { failedAfterSend: 1 },
      },
      anyVisibleDelivered: true,
    });
  });

  it.each([
    { finalFirst: false, queueCustody: "held" },
    { finalFirst: true, queueCustody: "held" },
    { finalFirst: false, queueCustody: "released" },
    { finalFirst: true, queueCustody: "released" },
  ] as const)(
    "does not retry a turn when siblings retain custody ($queueCustody, finalFirst=$finalFirst)",
    async ({ finalFirst, queueCustody }) => {
      const error = noSendError();
      const finalError = recoveryError(error, queueCustody);
      const { dispatcher, ledger, attempts } = deliveryHarness(
        finalFirst ? [finalError, error] : [error, finalError],
        {
          propagateRetryableNoSendFailure: true,
        },
      );
      if (finalFirst) {
        dispatcher.sendFinalReply({ text: "answer" });
      }
      dispatcher.sendBlockReply({ text: "progress" });
      if (!finalFirst) {
        dispatcher.sendFinalReply({ text: "answer" });
      }
      dispatcher.markComplete();

      if (queueCustody === "held") {
        await expect(dispatcher.waitForIdle()).resolves.toMatchObject({
          anyVisibleDelivered: false,
          hasPendingDelivery: true,
          counts: { block: { failedBeforeSend: 1 }, final: { failedBeforeSend: 1 } },
        });
        await ledger.settleQueued();
        expect(ledger.canAttemptFallback()).toBe(false);
        expect(ledger.hasObservedDelivery()).toBe(false);
      } else {
        await expect(dispatcher.waitForIdle()).rejects.toBe(finalFirst ? finalError : error);
      }
      expect(attempts).toEqual(finalFirst ? ["answer", "progress"] : ["progress", "answer"]);
    },
  );
});
