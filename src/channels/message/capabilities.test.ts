import { describe, expect, it } from "vitest";
import {
  deriveDurableFinalDeliveryRequirements,
  deriveDurableFinalDeliveryRequirementsForBatch,
  payloadRequiresDurablePayloadTransport,
} from "./capabilities.js";

describe("deriveDurableFinalDeliveryRequirements", () => {
  it("derives payload-dependent delivery requirements", () => {
    expect(
      deriveDurableFinalDeliveryRequirements({
        payload: {
          text: "caption",
          mediaUrls: ["https://example.com/a.png"],
          replyToId: "reply-1",
        },
        threadId: 42,
        silent: true,
        payloadTransport: true,
        batch: true,
        reconcileUnknownSend: true,
        afterSendSuccess: true,
        afterCommit: true,
      }),
    ).toEqual({
      text: true,
      media: true,
      replyTo: true,
      thread: true,
      silent: true,
      messageSendingHooks: true,
      payload: true,
      batch: true,
      reconcileUnknownSend: true,
      afterSendSuccess: true,
      afterCommit: true,
    });
  });
});

describe("deriveDurableFinalDeliveryRequirementsForBatch", () => {
  it("keeps typed reasoning on the complete payload lane only for an opted-in target", () => {
    const payload = { text: "private thought", isReasoning: true };
    expect(payloadRequiresDurablePayloadTransport(payload)).toBe(false);
    expect(
      payloadRequiresDurablePayloadTransport(payload, { supportsReasoningPayloads: false }),
    ).toBe(false);
    expect(
      payloadRequiresDurablePayloadTransport(payload, { supportsReasoningPayloads: true }),
    ).toBe(true);
    // Existing cron includeReasoning callers do not acquire new durable requirements.
    expect(deriveDurableFinalDeliveryRequirementsForBatch({ payloads: [payload] })).toEqual({
      text: true,
      messageSendingHooks: true,
    });
  });

  it("unions capabilities across the final prepared payloads", () => {
    expect(
      deriveDurableFinalDeliveryRequirementsForBatch({
        payloads: [
          { text: "first" },
          {
            text: "caption",
            mediaUrl: "https://example.com/a.png",
            presentation: { blocks: [{ type: "text", text: "card" }] },
          },
        ],
        replyToId: "reply-1",
        reconcileUnknownSend: true,
      }),
    ).toEqual({
      text: true,
      media: true,
      replyTo: true,
      messageSendingHooks: true,
      payload: true,
      batch: true,
      reconcileUnknownSend: true,
    });
  });

  it("requires payload transport for structured send content", () => {
    expect(
      deriveDurableFinalDeliveryRequirementsForBatch({
        payloads: [{ text: "Meet here", location: { latitude: 1, longitude: 2 } }],
      }),
    ).toMatchObject({ text: true, payload: true });
  });
});
