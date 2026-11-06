import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "../../infra/outbound/deliver-types.js";
import type {
  DeliverOutboundPayloadsParams,
  OutboundDeliveryIntent,
} from "../../infra/outbound/deliver.js";

const deliverOutboundPayloads = vi.hoisted(() =>
  vi.fn<(params: DeliverOutboundPayloadsParams) => Promise<OutboundDeliveryResult[]>>(),
);

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: deliverOutboundPayloads,
}));

import {
  sendDurableMessageBatchCore as sendDurableMessageBatch,
  type DurableMessageSendContext,
  type DurableMessageSendContextParams,
  withDurableMessageSendContextCore as withDurableMessageSendContext,
} from "./send.js";

const cfg = {} as OpenClawConfig;

function sendParams(
  overrides: Partial<DurableMessageSendContextParams> = {},
): DurableMessageSendContextParams {
  return { cfg, channel: "telegram", to: "chat-1", payloads: [{ text: "hello" }], ...overrides };
}

function sendBatch(overrides: Partial<DurableMessageSendContextParams>) {
  return sendDurableMessageBatch(sendParams(overrides));
}

function withContext<T>(
  overrides: Partial<DurableMessageSendContextParams>,
  run: (ctx: DurableMessageSendContext) => Promise<T>,
) {
  return withDurableMessageSendContext(sendParams(overrides), run);
}

function mockDeliveryIntent(
  intent: Partial<OutboundDeliveryIntent>,
  results = [{ channel: "telegram", messageId: "msg-1" }],
) {
  deliverOutboundPayloads.mockImplementationOnce(async (params) => {
    params.onDeliveryIntent?.({
      id: "intent-1",
      channel: "telegram",
      to: "chat-1",
      queuePolicy: "required",
      ...intent,
    });
    return results;
  });
}

const previewReceipt = {
  primaryPlatformMessageId: "preview-1",
  platformMessageIds: ["preview-1"],
  parts: [],
  sentAt: 123,
};

function latestDeliveryRequest(): DeliverOutboundPayloadsParams {
  const request = deliverOutboundPayloads.mock.calls.at(-1)?.[0];
  assert(request, "expected delivery request");
  return request;
}

describe("withDurableMessageSendContext", () => {
  it("renders and sends through a durable send context", async () => {
    mockDeliveryIntent({});

    const result = await withContext({ threadId: 42, replyToId: "reply-1" }, async (ctx) => {
      expect(ctx.id).toBe("telegram:chat-1");
      expect(ctx.channel).toBe("telegram");
      expect(ctx.to).toBe("chat-1");
      expect(ctx.durability).toBe("required");
      expect(ctx.attempt).toBe(1);
      const rendered = await ctx.render();
      expect(rendered).toEqual({
        payloads: [{ text: "hello" }],
        plan: {
          payloadCount: 1,
          textCount: 1,
          mediaCount: 0,
          voiceCount: 0,
          presentationCount: 0,
          interactiveCount: 0,
          channelDataCount: 0,
          items: [{ index: 0, kinds: ["text"] as const, text: "hello", mediaUrls: [] }],
        },
      });
      const send = await ctx.send(rendered);
      expect(ctx.intent?.id).toBe("intent-1");
      expect(ctx.intent?.channel).toBe("telegram");
      expect(ctx.intent?.to).toBe("chat-1");
      expect(ctx.intent?.durability).toBe("required");
      expect(ctx.intent?.renderedBatch).toBe(rendered);
      return send;
    });

    assert(result.status === "sent");
    expect(result.deliveryIntent?.id).toBe("intent-1");
    expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
    expect(result.receipt.threadId).toBe("42");
    expect(result.receipt.replyToId).toBe("reply-1");
    const request = latestDeliveryRequest();
    expect(request.queuePolicy).toBe("required");
    expect(request.payloads).toEqual([{ text: "hello" }]);
    expect(request.threadId).toBe(42);
    expect(request.replyToId).toBe("reply-1");
  });

  it("records a replayable rendered batch plan on the durable intent", async () => {
    mockDeliveryIntent({ id: "intent-media" }, [{ channel: "telegram", messageId: "media-1" }]);
    const renderedBatch = await withContext(
      {
        payloads: [
          {
            text: "caption",
            mediaUrls: ["file:///tmp/a.png", "file:///tmp/b.png"],
            audioAsVoice: true,
            presentation: { blocks: [{ type: "text", text: "card" }] },
            interactive: { blocks: [{ type: "buttons", buttons: [{ label: "OK" }] }] },
            channelData: { native: true },
          },
        ],
      },
      async (ctx) => {
        const rendered = await ctx.render();
        await ctx.send(rendered);
        return ctx.intent?.renderedBatch;
      },
    );

    expect(renderedBatch?.plan).toEqual({
      payloadCount: 1,
      textCount: 1,
      mediaCount: 2,
      voiceCount: 1,
      presentationCount: 1,
      interactiveCount: 1,
      channelDataCount: 1,
      items: [
        {
          index: 0,
          kinds: ["text", "voice", "presentation", "interactive", "channelData"] as const,
          text: "caption",
          mediaUrls: ["file:///tmp/a.png", "file:///tmp/b.png"],
          audioAsVoice: true,
          presentationBlockCount: 1,
          hasInteractive: true,
          hasChannelData: true,
        },
      ],
    });
  });

  it.each([
    {
      name: "title-only presentations",
      payload: { presentation: { title: "Delivery failed: action required", blocks: [] } },
      expected: { presentationCount: 1, items: [{ kinds: ["presentation"] }] },
    },
    {
      name: "single attachments mirrored by the media alias",
      payload: { mediaUrl: "/tmp/image.png", mediaUrls: ["/tmp/image.png"] },
      expected: { mediaCount: 1, items: [{ mediaUrls: ["/tmp/image.png"] }] },
    },
  ])("keeps $name visible in durable live previews", async ({ payload, expected }) => {
    await withContext({ payloads: [payload] }, async (ctx) => {
      const rendered = await ctx.render();
      expect(rendered.plan).toMatchObject(expected);
      expect((await ctx.previewUpdate(rendered)).lastRendered?.plan).toMatchObject(expected);
    });
  });

  it("forwards the durable send context signal to outbound delivery", async () => {
    const abortController = new AbortController();
    deliverOutboundPayloads.mockImplementationOnce(async (params) => {
      expect(params.abortSignal).toBe(abortController.signal);
      return [{ channel: "telegram", messageId: "msg-1" }];
    });

    const result = await sendBatch({ signal: abortController.signal });

    assert(result.status === "sent");
    expect(result.receipt?.platformMessageIds).toEqual(["msg-1"]);
    const request = latestDeliveryRequest();
    expect(request.abortSignal).toBe(abortController.signal);
    expect(request.queuePolicy).toBe("required");
  });

  it("maps best-effort durability to best-effort queue policy", async () => {
    mockDeliveryIntent({ id: "intent-best-effort", queuePolicy: "best_effort" });

    const result = await sendBatch({ durability: "best_effort" });

    assert(result.status === "sent");
    expect(result.deliveryIntent?.id).toBe("intent-best-effort");
    expect(latestDeliveryRequest().queuePolicy).toBe("best_effort");
  });

  it("keeps acknowledged multipart sends without platform ids authoritative", async () => {
    deliverOutboundPayloads.mockResolvedValueOnce(
      [123, 456].map((sentAt) => ({
        channel: "synology-chat",
        messageId: "",
        chatId: "42",
        receipt: {
          platformMessageIds: [],
          parts: [],
          threadId: "42",
          sentAt,
        },
      })),
    );
    const onCommitReceipt = vi.fn();

    const result = await sendBatch({
      channel: "synology-chat",
      to: "42",
      payloads: [{ text: "first" }, { text: "second" }],
      onCommitReceipt,
    });

    assert(result.status === "sent");
    expect(result.results).toHaveLength(2);
    expect(result.receipt).toMatchObject({
      platformMessageIds: [],
      parts: [],
      threadId: "42",
      sentAt: 123,
    });
    expect(result.receipt.primaryPlatformMessageId).toBeUndefined();
    expect(onCommitReceipt).toHaveBeenCalledWith(result.receipt);
  });

  it("supports preview, edit, and delete send-context hooks", async () => {
    const receipt = previewReceipt;
    const editedReceipt = {
      ...receipt,
      primaryPlatformMessageId: "preview-1-edited",
      platformMessageIds: ["preview-1-edited"],
    };
    const onEditReceipt = vi.fn<NonNullable<DurableMessageSendContextParams["onEditReceipt"]>>(
      async (original, rendered) => {
        expect(original).toBe(receipt);
        expect(rendered.payloads).toEqual([{ text: "final" }]);
        return editedReceipt;
      },
    );
    const onDeleteReceipt = vi.fn(async () => undefined);

    await withContext(
      {
        payloads: [{ text: "final" }],
        preview: {
          phase: "previewing",
          canFinalizeInPlace: true,
          receipt,
        },
        onEditReceipt,
        onDeleteReceipt,
      },
      async (ctx) => {
        const rendered = await ctx.render();
        const preview = await ctx.previewUpdate(rendered);
        expect(preview.lastRendered).toBe(rendered);

        await expect(ctx.edit(receipt, rendered)).resolves.toBe(editedReceipt);
        await ctx.delete(editedReceipt);
      },
    );

    expect(onEditReceipt).toHaveBeenCalledTimes(1);
    expect(onDeleteReceipt).toHaveBeenCalledWith(editedReceipt);
  });

  it.each(["edit", "delete"] as const)("rejects %s without a live adapter", async (operation) => {
    await withContext({}, async (ctx) => {
      await expect(ctx[operation](previewReceipt, await ctx.render())).rejects.toThrow(
        `message send context ${operation} is not configured`,
      );
    });
  });

  it("treats no visible outbound result as a committed suppressed send", async () => {
    mockDeliveryIntent({ id: "intent-2" }, []);
    const onCommitReceipt = vi.fn();

    const result = await sendBatch({ onCommitReceipt });

    assert(result.status === "suppressed");
    expect(result.reason).toBe("no_visible_result");
    expect(result.deliveryIntent?.id).toBe("intent-2");
    expect(onCommitReceipt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ platformMessageIds: [] }),
    );
  });

  it("forwards payload delivery outcomes to callers while collecting durable outcomes", async () => {
    const onPayloadDeliveryOutcome = vi.fn();
    const outcome = {
      index: 0,
      status: "suppressed",
      reason: "cancelled_by_message_sending_hook",
    } satisfies OutboundPayloadDeliveryOutcome;
    deliverOutboundPayloads.mockImplementationOnce(async (params) => {
      params.onPayloadDeliveryOutcome?.({ ...outcome });
      return [];
    });

    const result = await sendBatch({ onPayloadDeliveryOutcome });

    assert(result.status === "suppressed");
    expect(result.payloadOutcomes?.[0]).toEqual(outcome);
    expect(onPayloadDeliveryOutcome).toHaveBeenCalledExactlyOnceWith(outcome);
  });

  it("reports zero-result failed best-effort payloads as failed sends", async () => {
    const error = new Error("send failed");
    const outcome = {
      index: 0,
      status: "failed",
      error,
      sentBeforeError: false,
      stage: "platform_send",
    } satisfies OutboundPayloadDeliveryOutcome;
    deliverOutboundPayloads.mockImplementationOnce(async (params) => {
      params.onPayloadDeliveryOutcome?.({ ...outcome });
      return [];
    });
    const onCommitReceipt = vi.fn();
    const onSendFailure = vi.fn();

    const result = await sendBatch({ bestEffort: true, onCommitReceipt, onSendFailure });

    assert(result.status === "failed");
    expect(result.error).toBe(error);
    expect(result.stage).toBe("platform_send");
    expect(result.payloadOutcomes?.[0]).toEqual(outcome);
    expect(onCommitReceipt).not.toHaveBeenCalled();
    expect(onSendFailure).toHaveBeenCalledWith(error);
  });

  it("maps thrown outbound partial delivery errors to partial_failed", async () => {
    const cause = new Error("network reset");
    const error = new OutboundDeliveryError("network reset", {
      cause,
      results: [
        {
          channel: "telegram",
          messageId: "msg-1",
          receipt: {
            platformMessageIds: ["msg-1"],
            parts: [{ platformMessageId: "msg-1", kind: "text", index: 0 }],
            threadId: "canonical-thread",
            sentAt: 123,
          },
        },
      ],
      payloadOutcomes: [
        {
          index: 0,
          status: "sent",
          results: [{ channel: "telegram", messageId: "msg-1" }],
        },
        {
          index: 1,
          status: "failed",
          error: cause,
          sentBeforeError: true,
          stage: "platform_send",
        },
      ],
      stage: "platform_send",
    });
    deliverOutboundPayloads.mockRejectedValueOnce(error);
    const onSendFailure = vi.fn();

    const result = await sendBatch({
      payloads: [{ text: "first" }, { text: "second" }],
      threadId: "requested-thread",
      onSendFailure,
    });

    assert(result.status === "partial_failed");
    expect(result.results).toEqual(error.results);
    expect(result.receipt?.platformMessageIds).toEqual(["msg-1"]);
    expect(result.receipt?.threadId).toBe("canonical-thread");
    expect(result.receipt?.parts[0]?.threadId).toBe("canonical-thread");
    expect(result.error).toBe(error);
    expect(result.sentBeforeError).toBe(true);
    expect(onSendFailure).toHaveBeenCalledWith(error);
  });

  it("runs the failure hook when send-context orchestration throws", async () => {
    const onSendFailure = vi.fn();
    const error = new Error("boom");

    await expect(
      withContext({ onSendFailure }, async () => {
        throw error;
      }),
    ).rejects.toThrow("boom");

    expect(onSendFailure).toHaveBeenCalledWith(error);
  });

  it("preserves failed send results when the failure hook throws", async () => {
    const error = new Error("send failed");
    deliverOutboundPayloads.mockRejectedValueOnce(error);
    const onSendFailure = vi.fn(async () => {
      throw new Error("cleanup failed");
    });

    const result = await sendBatch({ onSendFailure });

    expect(result).toEqual({ status: "failed", error });
    expect(onSendFailure).toHaveBeenCalledWith(error);
  });
});
