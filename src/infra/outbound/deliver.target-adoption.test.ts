// Covers adapter-opted target adoption across one durable outbound batch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const createResult = (messageId: string, threadId?: string) => ({
  channel: "matrix" as const,
  messageId,
  receipt: createMessageReceiptFromOutboundResults({
    results: messageId ? [{ channel: "matrix", messageId }] : [],
    ...(threadId ? { threadId } : {}),
  }),
});

function installOutbound(outbound: ChannelOutboundAdapter) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
      },
    ]),
  );
}

async function deliverBatch(params: {
  outbound: ChannelOutboundAdapter;
  payloads: Parameters<typeof createUnmodifiedPreparedOutboundBatch>[0];
  threadId?: string;
  bestEffort?: boolean;
}) {
  installOutbound(params.outbound);
  return await deliverOutboundPayloadsCore({
    cfg: {},
    channel: "matrix",
    to: "room-parent",
    payloads: [...params.payloads],
    preparedBatch: createUnmodifiedPreparedOutboundBatch(params.payloads),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    ...(params.bestEffort ? { bestEffort: true } : {}),
  });
}

function createAdapter(
  sendText: NonNullable<ChannelOutboundAdapter["sendText"]>,
  options: Partial<ChannelOutboundAdapter> = {},
) {
  const afterDeliverPayload = vi.fn();
  const adoptTargetFromDelivery = vi.fn<
    NonNullable<ChannelOutboundAdapter["adoptTargetFromDelivery"]>
  >(({ result }) => (result.receipt?.threadId ? { threadId: result.receipt.threadId } : null));
  return {
    afterDeliverPayload,
    adoptTargetFromDelivery,
    outbound: {
      deliveryMode: "direct",
      sendText,
      afterDeliverPayload,
      adoptTargetFromDelivery,
      ...options,
    } satisfies ChannelOutboundAdapter,
  };
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.restoreAllMocks();
});

describe("outbound durable-batch target adoption", () => {
  it("carries the first receipt-created thread through later text, media, pins, and hooks", async () => {
    const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(
      async ({ text, threadId }) =>
        createResult(`text:${text}`, text === "starter" ? "thread-created" : String(threadId)),
    );
    const sendMedia = vi.fn<NonNullable<ChannelOutboundAdapter["sendMedia"]>>(
      async ({ mediaUrl, threadId }) => createResult(`media:${mediaUrl}`, String(threadId)),
    );
    const pinDeliveredMessage = vi.fn();
    const { outbound, afterDeliverPayload, adoptTargetFromDelivery } = createAdapter(sendText, {
      normalizePayload: ({ payload }) => (payload.text === "suppress" ? null : payload),
      sendMedia,
      pinDeliveredMessage,
    });

    await deliverBatch({
      outbound,
      payloads: [
        { text: "suppress" },
        { text: "starter", delivery: { pin: true } },
        { text: "later text", delivery: { pin: true } },
        {
          text: "images",
          mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
          delivery: { pin: true },
        },
      ],
    });

    expect(sendText.mock.calls.map(([ctx]) => ctx.threadId)).toEqual([undefined, "thread-created"]);
    expect(sendMedia.mock.calls.map(([ctx]) => ctx.threadId)).toEqual([
      "thread-created",
      "thread-created",
    ]);
    expect(pinDeliveredMessage.mock.calls.map(([ctx]) => ctx.target.threadId)).toEqual([
      "thread-created",
      "thread-created",
      "thread-created",
    ]);
    expect(afterDeliverPayload.mock.calls.map(([ctx]) => ctx.target.threadId)).toEqual([
      "thread-created",
      "thread-created",
      "thread-created",
    ]);
    expect(adoptTargetFromDelivery).toHaveBeenCalledTimes(1);
  });

  it("adopts an identified accepted send before a later payload failure", async () => {
    const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(
      async ({ text, threadId, onDeliveryResult }) => {
        if (text === "no identity") {
          return createResult("", "thread-unidentified");
        }
        if (text === "failed") {
          await onDeliveryResult?.(createResult("progress-before-failure", "thread-failed"));
          throw new Error("send rejected");
        }
        return createResult(
          `text:${text}`,
          text === "starter" ? "thread-created" : String(threadId),
        );
      },
    );
    const { outbound, afterDeliverPayload, adoptTargetFromDelivery } = createAdapter(sendText);

    await deliverBatch({
      outbound,
      bestEffort: true,
      payloads: [
        { text: "no identity" },
        { text: "failed" },
        { text: "starter" },
        { text: "later" },
      ],
    });

    expect(sendText.mock.calls.map(([ctx]) => ctx.threadId)).toEqual([
      undefined,
      undefined,
      "thread-failed",
      "thread-failed",
    ]);
    expect(afterDeliverPayload.mock.calls.map(([ctx]) => ctx.target.threadId)).toEqual([
      "thread-failed",
      "thread-failed",
      "thread-failed",
    ]);
    expect(adoptTargetFromDelivery).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit caller thread authoritative", async () => {
    const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(async (ctx) =>
      createResult(`text:${ctx.text}`, "thread-from-receipt"),
    );
    const { outbound, afterDeliverPayload, adoptTargetFromDelivery } = createAdapter(sendText);

    await deliverBatch({
      outbound,
      threadId: "thread-explicit",
      payloads: [{ text: "first" }, { text: "second" }],
    });

    expect(sendText.mock.calls.map(([ctx]) => ctx.threadId)).toEqual([
      "thread-explicit",
      "thread-explicit",
    ]);
    expect(afterDeliverPayload.mock.calls.map(([ctx]) => ctx.target.threadId)).toEqual([
      "thread-explicit",
      "thread-explicit",
    ]);
    expect(adoptTargetFromDelivery).not.toHaveBeenCalled();
  });
});
