import { describe, expect, it, vi } from "vitest";
import { PLUGIN_COMMAND_DISPATCH } from "../plugins/plugin-command-dispatch-contract.js";
import {
  createReplyDispatcher,
  dispatchInboundMessage,
  type ReplyDispatcher,
} from "./reply-runtime.js";

describe("reply runtime public dispatcher compatibility", () => {
  it("rejects plugin-supplied event custody while retaining public reply options", async () => {
    const callback = vi.fn();
    const options = {
      isHeartbeat: true,
      onReplyStart: callback,
      internalEventExecution: { assertCurrent: callback, onStarted: callback },
      onReplyOperationOwned: callback,
      [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" as const },
    };
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });
    let dispatched = false;
    await dispatchInboundMessage({
      ctx: { Body: "hello", SessionKey: "agent:main:sdk-reply", CommandAuthorized: false },
      cfg: {},
      dispatcher,
      replyOptions: options,
      dispatchReplyFromConfig: async ({ replyOptions }) => {
        dispatched = true;
        expect(replyOptions).not.toHaveProperty("internalEventExecution");
        expect(replyOptions).not.toHaveProperty("onReplyOperationOwned");
        expect(replyOptions).toMatchObject({
          isHeartbeat: true,
          onReplyStart: callback,
          [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
        });
        dispatcher.sendFinalReply({ text: "public reply" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    });
    expect(dispatched).toBe(true);
    expect(delivered).toEqual(["public reply"]);
    expect(options.internalEventExecution.onStarted).toBe(callback);
    expect(options.onReplyOperationOwned).toBe(callback);
  });

  it("preserves deprecated admission counters beside settled receipt outcomes", async () => {
    let releaseFirstDelivery!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    let firstDeliveryPending = true;
    const dispatcher: ReplyDispatcher = createReplyDispatcher({
      beforeDeliver: async (payload) => (payload.text === "cancel" ? null : payload),
      deliver: async (payload) => {
        if (firstDeliveryPending) {
          firstDeliveryPending = false;
          await firstDelivery;
        }
        if (payload.text === "fail") {
          throw new Error("transport failed after send started");
        }
      },
    });

    dispatcher.sendToolResult({ text: "delivered" });
    dispatcher.sendBlockReply({ text: "cancel" });
    dispatcher.sendFinalReply({ text: "fail" });

    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 1, block: 1, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });

    releaseFirstDelivery();
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(receipt).toMatchObject({
      anyVisibleDelivered: true,
      counts: {
        tool: { delivered: 1 },
        block: { cancelled: 1 },
        final: { failedAfterSend: 1 },
      },
    });
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 1, block: 1, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 1, final: 0 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
  });
});
