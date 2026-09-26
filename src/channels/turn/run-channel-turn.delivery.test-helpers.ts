import { expect, vi } from "vitest";
import { withReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatchSettledCounts } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type {
  ReplyDispatchKind,
  ReplyDispatchReceipt,
  ReplyDispatchSettledCounts,
  ReplyDispatcher,
} from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { RecordInboundSession } from "../session.types.js";
import type { ChannelTurnResult } from "./types.js";

export type DurableSendRequest = {
  accountId?: string;
  channel?: string;
  durability?: string;
  payloads?: ReplyPayload[];
  replyToMode?: string;
  session?: {
    key?: string;
    agentId?: string;
    requesterAccountId?: string;
    requesterSenderId?: string;
    conversationType?: string;
  };
  threadId?: string | number | null;
  to?: string;
};

export type DurableSupportRequest = {
  channel?: string;
  requirements?: Record<string, boolean>;
};

export function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    From: "sender",
    To: "target",
    SessionKey: "agent:main:test:peer",
    Provider: "test",
    Surface: "test",
    ...overrides,
  } as FinalizedMsgContext;
}

export function createRecordInboundSession(events: string[] = []): RecordInboundSession {
  return vi.fn(async () => {
    events.push("record");
  }) as unknown as RecordInboundSession;
}

export function createDurableSendResult(messageIds: string[]) {
  return {
    status: "sent",
    results: messageIds.map((messageId) => ({ messageId })),
    receipt: {
      platformMessageIds: messageIds,
      parts: [],
      sentAt: 1,
    },
  };
}

export function expectDispatched<TDispatchResult>(
  result: ChannelTurnResult<TDispatchResult>,
): asserts result is Extract<ChannelTurnResult<TDispatchResult>, { dispatched: true }> {
  expect(result.dispatched).toBe(true);
  if (!result.dispatched) {
    throw new Error("expected dispatch");
  }
}

export function createDispatch(
  events: string[] = [],
  deliverPayload: ReplyPayload = { text: "reply" },
  onDelivery?: (result: unknown) => void,
): DispatchReplyWithBufferedBlockDispatcher {
  const dispatch = createDispatcherBackedDispatch(undefined, (dispatcher) =>
    dispatcher.sendFinalReply(deliverPayload),
  );
  return vi.fn<DispatchReplyWithBufferedBlockDispatcher>(async (params) => {
    events.push("dispatch");
    return await dispatch({
      ...params,
      dispatcherOptions: {
        ...params.dispatcherOptions,
        deliver: async (payload, info) => {
          const delivery = await params.dispatcherOptions.deliver(payload, info);
          onDelivery?.(delivery);
          return delivery;
        },
      },
    });
  });
}

// These caller probes propagate rejection; the canonical dispatcher instead records a receipt.
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
  onReceipt?: (receipt: ReplyDispatchReceipt | undefined) => void,
  enqueue: (dispatcher: ReplyDispatcher) => boolean = (dispatcher) =>
    dispatcher.sendFinalReply({ text: "reply" }),
): DispatchReplyWithBufferedBlockDispatcher {
  return vi.fn<DispatchReplyWithBufferedBlockDispatcher>(async (params) => {
    const dispatcher = createReplyDispatcher(params.dispatcherOptions);
    let settledReceipt: ReplyDispatchReceipt | undefined;
    const result = await withReplyDispatcher({
      dispatcher,
      run: async () => ({
        queuedFinal: enqueue(dispatcher),
        counts: dispatcher.getQueuedCounts(),
      }),
      onSettledReceipt: (receipt) => {
        settledReceipt = receipt;
        onReceipt?.(receipt);
      },
    });
    return { ...result, settledReceipt };
  });
}

export function createReplyDispatchReceipt(
  outcomes: Partial<Record<ReplyDispatchKind, Partial<ReplyDispatchSettledCounts>>>,
): ReplyDispatchReceipt {
  const counts = (kind: ReplyDispatchKind): ReplyDispatchSettledCounts => ({
    ...createReplyDispatchSettledCounts(),
    ...outcomes[kind],
  });
  const receipt = { tool: counts("tool"), block: counts("block"), final: counts("final") };
  const anyVisibleDelivered = Object.values(receipt).some(
    (entry) => entry.delivered > 0 || entry.failedAfterSend > 0,
  );
  return { counts: receipt, anyVisibleDelivered };
}

export function expectNonVisibleFinalReceipt(result: unknown) {
  expect(result).toMatchObject({
    settledReceipt: {
      anyVisibleDelivered: false,
      counts: { final: { deliveredNotVisible: 1 } },
    },
  });
}
