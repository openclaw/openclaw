import { describe, expect, it, onTestFinished, vi } from "vitest";
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

function trackedLedger(
  options: Parameters<typeof createReplyDispatcher>[0] = { deliver: async () => {} },
) {
  const dispatcher = createReplyDispatcher(options);
  onTestFinished(async () => {
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });
  return { dispatcher, ledger: createReplyTurnLedger(dispatcher) };
}

describe("createReplyTurnLedger", () => {
  it("rejects a branded delivery error with an invalid outcome", () => {
    expect(
      isReplyDispatchDeliveryError({ code: "REPLY_DISPATCH_DELIVERY_ERROR", outcome: "invalid" }),
    ).toBe(false);
  });

  it("distinguishes visible progress from a settled terminal reply", async () => {
    const { ledger } = trackedLedger();
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
  });

  it("preserves a legacy idle observer's rejection", async () => {
    const error = new Error("Synthetic idle failure");
    const ledger = createReplyTurnLedger(
      createUntrackedDispatcher({
        waitForIdle: async () => {
          throw error;
        },
      }),
    );
    await expect(ledger.settleQueued()).rejects.toBe(error);
  });

  it("keeps caller cancellation ahead of a same-turn idle receipt", async () => {
    const controller = new AbortController();
    const ledger = createReplyTurnLedger(
      createUntrackedDispatcher({
        waitForIdle: async () => {
          queueMicrotask(() => controller.abort());
        },
      }),
    );
    await expect(ledger.settleQueued(controller.signal)).resolves.toBe("aborted");
  });

  it("does not authorize another final after an adapter copies a terminal payload", async () => {
    const deliver = vi.fn(async () => {});
    const { dispatcher, ledger } = trackedLedger({ deliver });
    const sendFinalReply = dispatcher.sendFinalReply.bind(dispatcher);
    dispatcher.sendFinalReply = (payload) => sendFinalReply({ ...payload });
    ledger.sendQueued("final", { text: "The requested answer." });
    await ledger.settleQueued();
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

  it.each([false, true])(
    "releases a hung transport on abort (already aborted=%s)",
    async (alreadyAborted) => {
      const stalled = createDeferred();
      const { ledger } = trackedLedger({ deliver: () => stalled.promise });
      ledger.sendQueued("final", { text: "hello" });
      const abortController = new AbortController();
      if (alreadyAborted) {
        abortController.abort();
      }
      const settled = ledger.settleQueued(abortController.signal);
      if (!alreadyAborted) {
        abortController.abort();
      }
      try {
        await expect(
          alreadyAborted ? Promise.race([settled, Promise.resolve("pending")]) : settled,
        ).resolves.toBe("aborted");
        expect(ledger.mayHaveDelivered()).toBe(false);
      } finally {
        stalled.resolve();
        await settled;
      }
    },
  );
});
