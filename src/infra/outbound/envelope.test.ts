import { describe, expect, it } from "vitest";
import type { OutboundDeliveryJson } from "./format.js";
import { buildOutboundResultEnvelope } from "./envelope.js";

describe("buildOutboundResultEnvelope", () => {
  it("flattens delivery-only payloads by default", () => {
    const delivery: OutboundDeliveryJson = {
      provider: "whatsapp",
      via: "gateway",
      to: "+1",
      messageId: "m1",
      mediaUrl: null,
    };
    expect(buildOutboundResultEnvelope({ delivery })).toEqual(delivery);
  });

  it("keeps payloads and meta in the envelope", () => {
    const envelope = buildOutboundResultEnvelope({
      payloads: [{ text: "hi", mediaUrl: null, mediaUrls: undefined }],
      meta: { foo: "bar" },
    });
    expect(envelope).toEqual({
      payloads: [{ text: "hi", mediaUrl: null, mediaUrls: undefined }],
      meta: { foo: "bar" },
    });
  });

  it("includes delivery when payloads are present", () => {
    const delivery: OutboundDeliveryJson = {
      provider: "telegram",
      via: "direct",
      to: "123",
      messageId: "m2",
      mediaUrl: null,
      chatId: "c1",
    };
    const envelope = buildOutboundResultEnvelope({
      payloads: [],
      delivery,
      meta: { ok: true },
    });
    expect(envelope).toEqual({
      payloads: [],
      meta: { ok: true },
      delivery,
    });
  });

  it("can keep delivery wrapped when requested", () => {
    const delivery: OutboundDeliveryJson = {
      provider: "discord",
      via: "gateway",
      to: "channel:C1",
      messageId: "m3",
      mediaUrl: null,
      channelId: "C1",
    };
    const envelope = buildOutboundResultEnvelope({
      delivery,
      flattenDelivery: false,
    });
    expect(envelope).toEqual({ delivery });
  });
});
