import { beforeEach, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type { DurableMessageSendContextParams } from "../message/send.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import { createCtx, createDurableSendResult } from "./run-channel-turn.delivery.test-helpers.js";
import type { ChannelDeliveryInfo } from "./types.js";

const { sendBatch, support } = vi.hoisted(() => ({ sendBatch: vi.fn(), support: vi.fn() }));
vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/deliver.js")>()),
  resolveOutboundDurableFinalDeliverySupport: support,
}));
vi.mock("../message/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../message/send.js")>()),
  sendDurableMessageBatchCore: sendBatch,
  sendStructuredDurableMessageBatchCore: sendBatch,
}));
vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: async () => [],
}));

beforeEach(() => {
  vi.clearAllMocks();
  support.mockResolvedValue({ ok: true });
});

it.each(["direct", "prepared", "durable", "durable-prepared"] as const)(
  "starts dispatcher-owned typing only at %s platform delivery",
  async (operation) => {
    const events: string[] = [];
    const prepared = operation.includes("prepared");
    const durable = operation.startsWith("durable");
    const deliver = async (_payload: ReplyPayload, info: ChannelDeliveryInfo) => {
      events.push("platform-ready");
      await info.startVisibleDeliveryTyping?.();
      await info.startVisibleDeliveryTyping?.();
      events.push("sent");
      return { visibleReplySent: true };
    };
    sendBatch.mockImplementation(async (params: DurableMessageSendContextParams) => {
      events.push("platform-ready");
      await params.onPlatformSendDispatch?.();
      events.push("sent");
      return createDurableSendResult(["visible-1"]);
    });
    await dispatchRoutedChannelTurn({
      cfg: {},
      channel: "whatsapp",
      route: { agentId: "main", sessionKey: "agent:main:whatsapp:group:typing" },
      ctxPayload: createCtx({
        SessionKey: "agent:main:whatsapp:group:typing",
        Provider: "whatsapp",
        Surface: "whatsapp",
        ChatType: "group",
        From: "typing@g.us",
        OriginatingTo: "typing@g.us",
      }),
      replyOptions: { typingStartPolicy: "visible_delivery" },
      dispatcherOptions: {
        onReplyStart: () => {
          events.push("composing");
        },
      },
      dispatchReplyFromConfig: async ({ dispatcher }) => {
        events.push("model");
        const payload = { text: "visible reply" };
        if (prepared) {
          const [plan] = createStructuredOutboundPayloadPlan([payload]);
          if (!plan || !dispatcher.sendPreparedReply) {
            throw new Error("expected prepared dispatcher");
          }
          dispatcher.sendPreparedReply("final", plan);
        } else {
          dispatcher.sendFinalReply(payload);
        }
        return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
      },
      delivery: {
        ...(durable
          ? {
              durable: () => ({
                to: "typing@g.us",
              }),
            }
          : {}),
        deliver,
        deliverPrepared: (plan, info) => deliver(plan.payload, info),
      },
    });
    expect(events).toEqual(["model", "platform-ready", "composing", "sent"]);
    expect(sendBatch).toHaveBeenCalledTimes(durable ? 1 : 0);
  },
);
