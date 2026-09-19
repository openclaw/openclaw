import { vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { sendPoll } from "./message.js";

type SendPollParams = Parameters<typeof sendPoll>[0];

export function createPollDeliveryFixture() {
  const order: string[] = [];
  const evidence = {
    channel: "demo-outbound",
    messageId: "poll-1",
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ messageId: "poll-1" }],
      kind: "poll",
      sentAt: 1,
    }),
  };
  const onSendAccepted = vi.fn(async () => {
    order.push("route");
  });
  const onDeliveryResult = vi.fn(async () => {
    order.push("receipt");
  });
  const sendPoll = async (params: SendPollParams) => {
    await params.onDeliveryResult?.(evidence);
    return {
      channel: "demo-outbound",
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: null,
      durationHours: null,
      via: "gateway",
    };
  };
  return { evidence, onDeliveryResult, onSendAccepted, order, sendPoll };
}
