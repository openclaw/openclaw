// Tests before-deliver hook ordering and payload mutation behavior.
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { attachReplyDispatchDeliveryCompletion } from "./reply-dispatcher-after-deliver.js";
import {
  appendReplyDispatcherBeforeDeliverCancelled,
  composeReplyDispatchBeforeDeliver,
  createReplyDispatcher,
} from "./reply-dispatcher.js";

describe("beforeDeliver in reply dispatcher", () => {
  it("cancels delivery before queueing when transformReplyPayload returns null", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      transformReplyPayload: (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    expect(dispatcher.sendFinalReply({ text: "blocked reply" })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: "safe reply" })).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("cancels delivery when beforeDeliver returns null", async () => {
    const delivered: string[] = [];
    const cancelled: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      onBeforeDeliverCancelled: (payload) => {
        cancelled.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "blocked reply" });
    dispatcher.sendFinalReply({ text: "safe reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(cancelled).toEqual(["blocked reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 2 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
  });

  it("notifies appended cancellation observers when beforeDeliver returns null", async () => {
    const delivered: string[] = [];
    const cancelled: string[] = [];
    const errors: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: () => null,
      onBeforeDeliverCancelled: (payload) => {
        cancelled.push(`constructed:${payload.text ?? ""}`);
      },
      onError: (err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });
    appendReplyDispatcherBeforeDeliverCancelled(dispatcher, (payload) => {
      cancelled.push(`appended-a:${payload.text ?? ""}`);
    });
    appendReplyDispatcherBeforeDeliverCancelled(dispatcher, () => {
      throw new Error("observer failed");
    });
    appendReplyDispatcherBeforeDeliverCancelled(dispatcher, (payload) => {
      cancelled.push(`appended-b:${payload.text ?? ""}`);
    });

    dispatcher.sendFinalReply({ text: "blocked reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    expect(cancelled).toEqual([
      "constructed:blocked reply",
      "appended-a:blocked reply",
      "appended-b:blocked reply",
    ]);
    expect(errors).toEqual(["observer failed"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("notifies cancellation when beforeDeliver throws before delivery", async () => {
    const delivered: string[] = [];
    const cancelled: Array<{
      assistantMessageIndex?: number;
      kind: string;
      text: string;
    }> = [];
    const errors: Array<{
      assistantMessageIndex?: number;
      kind: string;
      message: string;
    }> = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      onBeforeDeliverCancelled: (payload, info) => {
        cancelled.push({
          assistantMessageIndex: info.assistantMessageIndex,
          kind: info.kind,
          text: payload.text ?? "",
        });
      },
      onError: (err, info) => {
        errors.push({
          assistantMessageIndex: info.assistantMessageIndex,
          kind: info.kind,
          message: err instanceof Error ? err.message : String(err),
        });
      },
      beforeDeliver: async () => {
        throw new Error("pre-delivery failed");
      },
    });

    dispatcher.sendBlockReply(
      setReplyPayloadMetadata({ text: "blocked block" }, { assistantMessageIndex: 9 }),
    );
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    expect(cancelled).toEqual([{ assistantMessageIndex: 9, kind: "block", text: "blocked block" }]);
    expect(errors).toEqual([
      { assistantMessageIndex: 9, kind: "block", message: "pre-delivery failed" },
    ]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 1, final: 0 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 1, final: 0 });
  });

  it("allows modifying payload in beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("error")) {
          return { ...payload, text: "replaced" };
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "some error occurred" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["replaced"]);
  });

  it("preserves payload metadata through beforeDeliver rewrites", async () => {
    let deliveredMetadata: unknown;
    let deliveredAssistantMessageIndex: unknown;

    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        deliveredMetadata = getReplyPayloadMetadata(payload);
        deliveredAssistantMessageIndex = info.assistantMessageIndex;
      },
      beforeDeliver: async () =>
        setReplyPayloadMetadata(
          { text: "rewritten" },
          { outboundHookLifecycle: { state: "prepared", preparedMediaCount: 0 } },
        ),
    });

    dispatcher.sendBlockReply(
      setReplyPayloadMetadata({ text: "original" }, { assistantMessageIndex: 12 }),
    );
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredMetadata).toMatchObject({
      assistantMessageIndex: 12,
      outboundHookLifecycle: { state: "prepared", preparedMediaCount: 0 },
    });
    expect(deliveredAssistantMessageIndex).toBe(12);
  });

  it("preserves metadata finalized after a beforeDeliver rewrite", async () => {
    let deliveredMetadata: unknown;
    const beforeDeliver = composeReplyDispatchBeforeDeliver(
      (payload) =>
        setReplyPayloadMetadata(payload, {
          outboundHookLifecycle: { state: "pending" },
        }),
      (payload) => ({ ...payload, text: "rewritten" }),
      (payload) =>
        setReplyPayloadMetadata(payload, {
          outboundHookLifecycle: { state: "prepared", preparedMediaCount: 0 },
        }),
    );
    const dispatcher = createReplyDispatcher({
      beforeDeliver,
      deliver: async (payload) => {
        deliveredMetadata = getReplyPayloadMetadata(payload);
      },
    });

    dispatcher.sendFinalReply({ text: "original" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredMetadata).toMatchObject({
      outboundHookLifecycle: { state: "prepared", preparedMediaCount: 0 },
    });
  });

  it("brackets provider preparation and native delivery with lifecycle observers", async () => {
    const events: string[] = [];
    const dispatcher = createReplyDispatcher({
      beforeDeliver: (payload) => {
        events.push("provider-before");
        return payload;
      },
      deliver: async () => {
        events.push("native-send");
        return { messageId: "m1" };
      },
    });
    dispatcher.prependBeforeDeliver?.((payload) => {
      events.push("core-before");
      return payload;
    });
    dispatcher.appendAfterDeliver?.((_payload, _info, outcome) => {
      events.push(outcome.status === "delivered" ? "core-after-success" : "core-after-failure");
    });

    dispatcher.sendFinalReply({ text: "hello" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(events).toEqual(["core-before", "provider-before", "native-send", "core-after-success"]);
  });

  it("uses one stable delivery identity per queued payload across every callback", async () => {
    const observed: Array<{ stage: string; deliveryId?: number }> = [];
    const dispatcher = createReplyDispatcher({
      beforeDeliver: (payload, info) => {
        observed.push({ stage: "before", deliveryId: info.deliveryId });
        return payload;
      },
      deliver: async (_payload, info) => {
        observed.push({ stage: "deliver", deliveryId: info.deliveryId });
      },
      onDeliverySettled: (info) => {
        observed.push({ stage: "settled", deliveryId: info.deliveryId });
      },
    });
    dispatcher.appendAfterDeliver?.((_payload, info) => {
      observed.push({ stage: "after", deliveryId: info.deliveryId });
    });

    dispatcher.sendFinalReply({ text: "first" });
    dispatcher.sendFinalReply({ text: "second" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(observed).toEqual([
      { stage: "before", deliveryId: 0 },
      { stage: "deliver", deliveryId: 0 },
      { stage: "after", deliveryId: 0 },
      { stage: "settled", deliveryId: 0 },
      { stage: "before", deliveryId: 1 },
      { stage: "deliver", deliveryId: 1 },
      { stage: "after", deliveryId: 1 },
      { stage: "settled", deliveryId: 1 },
    ]);
  });

  it("keeps synchronous afterDeliver observer failures non-interfering", async () => {
    const delivered: string[] = [];
    const errors: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
        return { messageId: "m1" };
      },
      onError: (err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });
    dispatcher.appendAfterDeliver?.(() => {
      throw new Error("observer failed");
    });

    dispatcher.sendFinalReply({ text: "hello" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await vi.waitFor(() => expect(errors).toEqual(["observer failed"]));

    expect(delivered).toEqual(["hello"]);
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("keeps afterDeliver error-reporter failures non-interfering", async () => {
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      onError: () => {
        throw new Error("error reporter failed");
      },
    });
    dispatcher.appendAfterDeliver?.(() => {
      throw new Error("observer failed");
    });

    dispatcher.sendFinalReply({ text: "hello" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delivered).toEqual(["hello"]);
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("defers afterDeliver observers until channel finalization settles", async () => {
    let resolveCompletion!: (result: { messageId: string }) => void;
    const completion = new Promise<{ messageId: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const outcomes: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async () =>
        attachReplyDispatchDeliveryCompletion({ visibleReplySent: false }, completion),
    });
    dispatcher.appendAfterDeliver?.((_payload, _info, outcome) => {
      outcomes.push(
        outcome.status === "delivered"
          ? String((outcome.result as { messageId?: string }).messageId)
          : "failed",
      );
    });

    dispatcher.sendFinalReply({ text: "hello" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(outcomes).toEqual([]);

    resolveCompletion({ messageId: "finalized-1" });
    await vi.waitFor(() => expect(outcomes).toEqual(["finalized-1"]));
  });

  it("defers failed afterDeliver observers until channel finalization settles", async () => {
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<never>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const outcomes: string[] = [];
    const providerError = new Error("media upload failed");
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw attachReplyDispatchDeliveryCompletion(providerError, completion);
      },
    });
    dispatcher.appendAfterDeliver?.((_payload, _info, outcome) => {
      outcomes.push(outcome.status === "failed" ? String(outcome.error) : "delivered");
    });

    dispatcher.sendFinalReply({ text: "hello" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(outcomes).toEqual([]);

    rejectCompletion(new Error("finalized partial failure"));
    await vi.waitFor(() => expect(outcomes).toEqual(["Error: finalized partial failure"]));
  });

  it("delivers normally without beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    dispatcher.sendFinalReply({ text: "plain reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["plain reply"]);
  });
});
