import { assert, expect, vi } from "vitest";
import { withReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatchSettledCounts } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type {
  ReplyDispatchReceipt,
  ReplyDispatcher,
} from "../../auto-reply/reply/reply-dispatcher.types.js";
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
  deliverPayload: ReplyPayload = { text: "reply" },
  onDelivery?: (result: unknown) => void,
): DispatchReplyWithBufferedBlockDispatcher {
  const dispatch = createDispatcherBackedDispatch(
    () => {},
    () => deliverPayload,
  );
  return vi.fn<DispatchReplyWithBufferedBlockDispatcher>(async (params) => {
    events.push("dispatch");
    return dispatch({
      ...params,
      dispatcherOptions: {
        ...params.dispatcherOptions,
        deliver: async (payload, info) => {
          const result = await params.dispatcherOptions.deliver(payload, info);
          onDelivery?.(result);
          return result;
        },
      },
    });
  });
}

// These probes assert raw callback rejection; the real dispatcher records it through onError.
export function createDirectDeliveryDispatch(): DispatchReplyWithBufferedBlockDispatcher {
  return vi.fn<DispatchReplyWithBufferedBlockDispatcher>(async (params) => {
    await params.dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  });
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
  enqueue: (dispatcher: ReplyDispatcher, payload: ReplyPayload) => boolean = (
    dispatcher,
    payload,
  ) => dispatcher.sendFinalReply(payload),
): DispatchReplyWithBufferedBlockDispatcher {
  return vi.fn<DispatchReplyWithBufferedBlockDispatcher>(async (params) => {
    // Replays need a fresh payload, and a failed factory must not leave a dispatcher open.
    const payload = createPayload();
    const dispatcher = createReplyDispatcher(params.dispatcherOptions);
    let settledReceipt: ReplyDispatchReceipt | undefined;
    const queuedFinal = await withReplyDispatcher({
      dispatcher,
      run: async () => enqueue(dispatcher, payload),
      onSettledReceipt: (receipt) => {
        settledReceipt = receipt;
        onReceipt(receipt);
      },
    });
    return { queuedFinal, counts: dispatcher.getQueuedCounts(), settledReceipt };
  });
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
