import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { buildOutboundResultEnvelope } from "./envelope.js";
import type { OutboundDeliveryJson } from "./format.js";

describe("buildOutboundResultEnvelope", () => {
  const delivery: OutboundDeliveryJson = {
    channel: "telegram",
    via: "direct",
    to: "123",
    messageId: "m1",
    mediaUrl: null,
    chatId: "c1",
  };

  it("flattens delivery by default when nothing else is present", () => {
    expect(buildOutboundResultEnvelope({ delivery })).toEqual(delivery);
  });

  it("keeps pre-normalized payload JSON entries but clones the array", () => {
    const payloads = [{ text: "hi", mediaUrl: null, mediaUrls: undefined }];

    const envelope = buildOutboundResultEnvelope({
      payloads,
      meta: { ok: true },
    });

    expect(envelope).toEqual({
      payloads: [{ text: "hi", mediaUrl: null, mediaUrls: undefined }],
      meta: { ok: true },
    });
    expect((envelope as { payloads: unknown[] }).payloads).not.toBe(payloads);
  });

  it("normalizes reply payloads and keeps wrapped delivery when flattening is disabled", () => {
    const payloads: ReplyPayload[] = [{ text: "hello" }];

    expect(
      buildOutboundResultEnvelope({
        payloads,
        delivery,
        flattenDelivery: false,
      }),
    ).toEqual({
      payloads: [
        {
          text: "hello",
          mediaUrl: null,
          channelData: undefined,
        },
      ],
      delivery,
    });
  });
});
