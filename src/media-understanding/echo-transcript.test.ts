// Transcript echo tests cover destination resolution, custom formatting,
// channel filtering, metadata forwarding, and failure swallowing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";

const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());

vi.mock("../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
  deliverOutboundPayloadsInternal: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
  deliverOutboundPayloadsInternal: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) =>
    channel === "voicechat" || channel === "telegram",
}));

import { sendTranscriptEcho } from "./echo-transcript.js";

const EMPTY_CONFIG = {} as OpenClawConfig;

function createCtx(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "voicechat",
    From: "+10000000001",
    AccountId: "acc1",
    ...overrides,
  };
}

describe("sendTranscriptEcho", () => {
  beforeEach(() => {
    mockDeliverOutboundPayloads.mockReset();
    mockDeliverOutboundPayloads.mockResolvedValue({
      status: "sent",
      results: [{ channel: "voicechat", messageId: "echo-1" }],
      receipt: { platformMessageIds: ["echo-1"], parts: [], sentAt: 1 },
    });
  });

  it("keeps dollar sequences in the transcript literal", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: EMPTY_CONFIG,
      transcript: "tickets cost $$40, wait for the deal & confirm with $&",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: '📝 "tickets cost $$40, wait for the deal & confirm with $&"' }],
      }),
    );
  });

  it("skips non-deliverable channels", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ Provider: "internal-system", From: "some-source" }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips when ctx has no resolved destination", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ From: undefined, OriginatingTo: undefined }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("requires durable ownership for complete Telegram source identities", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        OriginatingTo: "telegram:group:-123:topic:7",
        MessageSid: "42",
      }),
      cfg: EMPTY_CONFIG,
      transcript: "same body",
    });
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        bestEffort: false,
        durability: "required",
        deliveryIntentId: expect.stringMatching(/^transcript-echo:v1:[a-f0-9]{64}$/),
        completionRetention: {
          idPrefix: "transcript-echo:v1:",
          maxAgeMs: 86_400_000,
          maxEntries: 2_000,
        },
      }),
    );
  });

  it.each([
    { AccountId: undefined },
    { MessageSid: undefined },
    { OriginatingTo: "telegram:bad chat" },
  ])("keeps incomplete Telegram identities best effort: %j", async (overrides) => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        OriginatingTo: "telegram:-123",
        MessageSid: "42",
        ...overrides,
      }),
      cfg: EMPTY_CONFIG,
      transcript: "same body",
    });
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ bestEffort: true, durability: "best_effort" }),
    );
    expect(mockDeliverOutboundPayloads.mock.calls[0]?.[0]).not.toHaveProperty("deliveryIntentId");
  });

  it("does not deduplicate other providers using Telegram source identity rules", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ MessageSid: "42" }),
      cfg: EMPTY_CONFIG,
      transcript: "same body",
    });
    expect(mockDeliverOutboundPayloads.mock.calls[0]?.[0]).toMatchObject({
      bestEffort: true,
      durability: "best_effort",
    });
    expect(mockDeliverOutboundPayloads.mock.calls[0]?.[0]).not.toHaveProperty("deliveryIntentId");
  });

  it("swallows delivery failures", async () => {
    mockDeliverOutboundPayloads.mockRejectedValueOnce(new Error("delivery timeout"));

    await expect(
      sendTranscriptEcho({
        ctx: createCtx(),
        cfg: EMPTY_CONFIG,
        transcript: "hello world",
      }),
    ).resolves.toBeUndefined();
  });
});
