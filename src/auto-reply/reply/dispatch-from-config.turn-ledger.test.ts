import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import { isReplyDispatchDeliveryError } from "./reply-dispatch-outcome.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

function createUntrackedDispatcher(overrides: Partial<ReplyDispatcher> = {}): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
    ...overrides,
  };
}

describe("reply delivery errors", () => {
  it("rejects a branded delivery error with an invalid outcome", () => {
    expect(
      isReplyDispatchDeliveryError({
        code: "REPLY_DISPATCH_DELIVERY_ERROR",
        outcome: "invalid",
      }),
    ).toBe(false);
  });
});

describe("createReplyTurnLedger", () => {
  it("distinguishes visible progress from a settled terminal reply", async () => {
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });
    const ledger = createReplyTurnLedger(dispatcher);
    ledger.sendQueued("tool", { text: "Checking the request." });
    ledger.sendQueued("block", { text: "Still working.", isCommentary: true });
    await ledger.settleQueued();
    expect(ledger.hasObservedDelivery()).toBe(true);
    expect(ledger.resolveTerminalDelivery()).toBe("missing");
    const send = ledger.sendQueued("final", { text: "hello" });
    expect(send.queued).toBe(true);
    expect(send.outcome).toBeDefined();
    await ledger.settleQueued();
    expect(ledger.mayHaveDelivered()).toBe(true);
    expect(ledger.hasObservedDelivery()).toBe(true);
    expect(ledger.resolveTerminalDelivery()).toBe("delivered");
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });

  it("does not count a pre-transport failure as visible", async () => {
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: async () => {
        throw new Error("hook exploded");
      },
    });
    const ledger = createReplyTurnLedger(dispatcher);
    expect(ledger.sendQueued("block", { text: "streamed" }).queued).toBe(true);
    await ledger.settleQueued();
    expect(deliver).not.toHaveBeenCalled();
    expect(ledger.mayHaveDelivered()).toBe(false);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });

  it("retains ambiguous terminal block custody without completing delivery", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new Error("transport down mid-send");
      },
    });
    const ledger = createReplyTurnLedger(dispatcher);
    expect(ledger.sendQueued("block", { text: "Final answer." }).queued).toBe(true);
    await ledger.settleQueued();
    expect(ledger.mayHaveDelivered()).toBe(true);
    expect(ledger.hasObservedDelivery()).toBe(false);
    expect(ledger.resolveTerminalDelivery()).toBe("pending");
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });

  it("times out instead of waiting forever on a transport that never settles", async () => {
    vi.useFakeTimers();
    try {
      const stalled = createDeferred();
      const dispatcher = createReplyDispatcher({ deliver: () => stalled.promise });
      const ledger = createReplyTurnLedger(dispatcher);
      ledger.sendQueued("final", { text: "hello" });
      const settle = ledger.settleQueued();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(settle).resolves.toBe("timed-out");
      stalled.resolve();
      dispatcher.markComplete();
      await vi.runAllTimersAsync();
      await dispatcher.waitForIdle();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps legacy accepted sends visible when settlement has no receipt", async () => {
    const ledger = createReplyTurnLedger(createUntrackedDispatcher());
    const send = ledger.sendQueued("final", { text: "hello" });
    expect(send.outcome).toBeUndefined();
    await ledger.settleQueued();
    expect(ledger.mayHaveDelivered()).toBe(true);
    expect(ledger.hasObservedDelivery()).toBe(false);
    expect(ledger.resolveTerminalDelivery()).toBe("pending");
  });

  it("does not authorize another final after an adapter copies a terminal payload", async () => {
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver });
    const sendFinalReply = dispatcher.sendFinalReply.bind(dispatcher);
    dispatcher.sendFinalReply = (payload) => sendFinalReply({ ...payload });
    const ledger = createReplyTurnLedger(dispatcher);
    ledger.sendQueued("final", { text: "The requested answer." });
    await ledger.settleQueued();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      { text: "The requested answer." },
      { kind: "final" },
    );
    expect(ledger.hasObservedDelivery()).toBe(true);
    expect(ledger.resolveTerminalDelivery()).toBe("pending");
  });

  it("records routed settlements only when delivered and contentful", () => {
    const ledger = createReplyTurnLedger(createUntrackedDispatcher());
    ledger.recordRoutedDelivery(
      "final",
      { text: "suppressed" },
      { ok: true, delivered: false, reason: "channel_transform" },
    );
    ledger.recordRoutedDelivery("final", { text: "" }, { ok: true, delivered: true });
    expect(ledger.mayHaveDelivered()).toBe(false);
    ledger.recordRoutedDelivery(
      "final",
      { mediaUrl: "https://example.com/seatmap.png" },
      { ok: true, delivered: true },
    );
    expect(ledger.mayHaveDelivered()).toBe(true);
  });

  it("stops settling when the abort signal fires", async () => {
    // A stalled deliver models a hung transport; abort must release the gate
    // instead of wedging finalization.
    const stalled = createDeferred();
    const dispatcher = createReplyDispatcher({ deliver: () => stalled.promise });
    const ledger = createReplyTurnLedger(dispatcher);
    ledger.sendQueued("final", { text: "hello" });
    const abortController = new AbortController();
    const settled = ledger.settleQueued(abortController.signal);
    abortController.abort();
    await expect(settled).resolves.toBe("aborted");
    expect(ledger.mayHaveDelivered()).toBe(false);
    stalled.resolve();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });

  it("settles immediately when the abort signal already fired", async () => {
    const stalled = createDeferred();
    const dispatcher = createReplyDispatcher({ deliver: () => stalled.promise });
    const ledger = createReplyTurnLedger(dispatcher);
    ledger.sendQueued("final", { text: "hello" });
    const abortController = new AbortController();
    abortController.abort();
    const settled = ledger.settleQueued(abortController.signal);

    try {
      await expect(Promise.race([settled, Promise.resolve("pending")])).resolves.toBe("aborted");
      expect(ledger.mayHaveDelivered()).toBe(false);
    } finally {
      stalled.resolve();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      await settled;
    }
  });
});
