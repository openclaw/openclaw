import { describe, expect, it } from "vitest";
import { projectPendingFinalDeliverySettlement } from "./session-pending-final-settlement.js";
import type { InternalSessionEntry } from "./types.js";

const topic = { channel: "telegram", to: "telegram:-100:topic:1467", accountId: "default" };
const otherTopic = { ...topic, to: "telegram:-100:topic:2" };

function entryWith(params: {
  noticeContext?: typeof topic;
  noticeState?: "owed" | "unresolved" | "acknowledged";
  pendingContext?: typeof topic;
}): InternalSessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    // Debt from the 08:38 reply whose response Telegram never returned.
    pendingDeliveryNotice: {
      createdAt: 100,
      context: params.noticeContext ?? topic,
      intentId: "lost-reply",
      state: params.noticeState ?? "owed",
    },
    // The 09:00 reply to the same topic.
    pendingFinalDelivery: {
      kind: "replayable",
      text: "later reply",
      context: params.pendingContext ?? topic,
      createdAt: 200,
      intentId: "later-reply",
      deliveries: [{ id: "delivery-1", state: "prepared" }],
    },
  } as InternalSessionEntry;
}

const settle = (entry: InternalSessionEntry, state: "delivered" | "unknown") =>
  projectPendingFinalDeliverySettlement(entry, {
    sessionId: "session-1",
    intentId: "later-reply",
    deliveryId: "delivery-1",
    state,
  });

describe("pending final settlement", () => {
  it.each(["owed", "unresolved"] as const)(
    "settles %s older debt once a later reply reaches the same chat",
    (noticeState) => {
      const { patch } = settle(entryWith({ noticeState }), "delivered");
      expect(patch?.pendingDeliveryNotice).toEqual({
        createdAt: 100,
        context: topic,
        intentId: "lost-reply",
        state: "acknowledged",
      });
    },
  );

  it("keeps the debt when the later reply went to another chat", () => {
    const { patch } = settle(entryWith({ pendingContext: otherTopic }), "delivered");
    expect(patch).not.toHaveProperty("pendingDeliveryNotice");
  });

  it("owes the newer debt when the later reply is also unconfirmed", () => {
    const { patch } = settle(entryWith({}), "unknown");
    expect(patch?.pendingDeliveryNotice).toMatchObject({ intentId: "later-reply", state: "owed" });
  });
});
