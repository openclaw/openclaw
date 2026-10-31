import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatchSettledCounts } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchReceipt } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { resolveOutboundDurableFinalDeliverySupport } from "../../infra/outbound/deliver.js";
import type { DurableMessageSendContextParams } from "../message/send.js";
import type { RecordInboundSession } from "../session.types.js";
import type { ChannelTurnResult } from "./types.js";
type Counts = ReplyDispatchReceipt["counts"];

export type DurableSendRequest = Partial<DurableMessageSendContextParams>;
export type DurableSupportRequest = Partial<
  Parameters<typeof resolveOutboundDurableFinalDeliverySupport>[0]
>;

export const createCtx = (overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext =>
  ({
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    From: "sender",
    To: "target",
    SessionKey: "agent:main:test:peer",
    Provider: "test",
    Surface: "test",
    ...overrides,
  }) as FinalizedMsgContext;

export function createRecordInboundSession(events: string[] = []): RecordInboundSession {
  return vi.fn<RecordInboundSession>(async () => void events.push("record"));
}

export const createDurableSendResult = (messageIds: string[]) => ({
  status: "sent",
  results: messageIds.map((messageId) => ({ messageId })),
  receipt: { platformMessageIds: messageIds, parts: [], sentAt: 1 },
});

export function expectDispatched<TDispatchResult>(
  result: ChannelTurnResult<TDispatchResult>,
): asserts result is Extract<ChannelTurnResult<TDispatchResult>, { dispatched: true }> {
  assert(result.dispatched, "expected dispatch");
}

export function createDispatch(
  events: string[] = [],
  deliverPayload: { text: string } = { text: "reply" },
  onDelivery?: (result: unknown) => void,
): DispatchReplyWithBufferedBlockDispatcher {
  return vi.fn(async (params) => {
    events.push("dispatch");
    const delivery = await params.dispatcherOptions.deliver(deliverPayload, { kind: "final" });
    onDelivery?.(delivery);
    const deliveredNotVisible = asOptionalObjectRecord(delivery)?.visibleReplySent === false;
    return {
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      settledReceipt: createReplyDispatchReceipt({
        final: deliveredNotVisible ? { deliveredNotVisible: 1 } : { delivered: 1 },
      }),
    };
  }) as DispatchReplyWithBufferedBlockDispatcher;
}

export function createDeliveryResultCapture() {
  let result: unknown;
  return {
    dispatch: createDispatch([], undefined, (delivery) => {
      result = delivery;
    }),
    getResult: () => result,
  };
}

export function createDispatcherBackedDispatch(
  onReceipt: (receipt: ReplyDispatchReceipt | undefined) => void,
  createPayload: () => ReplyPayload = () => ({ text: "reply" }),
): DispatchReplyWithBufferedBlockDispatcher {
  return vi.fn(async (params) => {
    const dispatcher = createReplyDispatcher(params.dispatcherOptions);
    dispatcher.sendFinalReply(createPayload());
    dispatcher.markComplete();
    const settledReceipt = (await dispatcher.waitForIdle()) || undefined;
    onReceipt(settledReceipt);
    return { queuedFinal: true, counts: dispatcher.getQueuedCounts(), settledReceipt };
  }) as DispatchReplyWithBufferedBlockDispatcher;
}

export function createReplyDispatchReceipt(
  outcomes: Partial<{ [K in keyof Counts]: Partial<Counts[K]> }>,
): ReplyDispatchReceipt {
  const counts = (kind: keyof Counts) => ({
    ...createReplyDispatchSettledCounts(),
    ...outcomes[kind],
  });
  const receipt = { tool: counts("tool"), block: counts("block"), final: counts("final") };
  const visible = Object.values(receipt).some((c) => c.delivered > 0 || c.failedAfterSend > 0);
  return { counts: receipt, anyVisibleDelivered: visible };
}

export function expectNonVisibleFinalReceipt(result: unknown) {
  expect(result).toHaveProperty("settledReceipt.anyVisibleDelivered", false);
  expect(result).toHaveProperty("settledReceipt.counts.final.deliveredNotVisible", 1);
}
