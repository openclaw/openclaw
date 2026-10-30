import { formatErrorMessage } from "../../infra/errors.js";
import type { ChannelMessageReceiveAckPolicy } from "./types.js";

export type MessageAckPolicy = ChannelMessageReceiveAckPolicy;

type MessageAckStage = "receive_record" | "agent_dispatch" | "durable_send" | "manual";

type MessageAckState = "pending" | "acked" | "nacked";

/** Mutable receive context passed through durable inbound message processing. */
export type MessageReceiveContext<TMessage = unknown> = {
  id: string;
  channel: string;
  accountId?: string;
  message: TMessage;
  ackPolicy: MessageAckPolicy;
  ackState: MessageAckState;
  ackedAt?: number;
  nackErrorMessage?: string;
  receivedAt: number;
  signal: AbortSignal;
  shouldAckAfter(stage: MessageAckStage): boolean;
  ack(): Promise<void>;
  nack(error: unknown): Promise<void>;
};

const neverAbortedSignal = new AbortController().signal;

const ackStages: Record<MessageAckPolicy, MessageAckStage | undefined> = {
  after_receive_record: "receive_record",
  after_agent_dispatch: "agent_dispatch",
  after_durable_send: "durable_send",
  manual: undefined,
};

/** Creates a receive context with idempotent ack and explicit nack state transitions. */
export function createMessageReceiveContext<TMessage>(params: {
  id: string;
  channel: string;
  accountId?: string;
  message: TMessage;
  ackPolicy?: MessageAckPolicy;
  receivedAt?: number;
  signal?: AbortSignal;
  onAck?: () => Promise<void> | void;
  onNack?: (error: unknown) => Promise<void> | void;
}): MessageReceiveContext<TMessage> {
  let nackInFlight: Promise<void> | undefined;
  const ctx: MessageReceiveContext<TMessage> = {
    id: params.id,
    channel: params.channel,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    message: params.message,
    ackPolicy: params.ackPolicy ?? "after_receive_record",
    ackState: "pending",
    receivedAt: params.receivedAt ?? Date.now(),
    signal: params.signal ?? neverAbortedSignal,
    shouldAckAfter: (stage) => ackStages[ctx.ackPolicy] === stage,
    ack: async () => {
      // Ack callbacks must be idempotent because receive pipelines may revisit completed stages.
      if (ctx.ackState === "acked") {
        return;
      }
      await params.onAck?.();
      ctx.ackState = "acked";
      ctx.ackedAt = Date.now();
      delete ctx.nackErrorMessage;
    },
    nack: async (error) => {
      // Share overlapping callbacks; clear rejected work so a later call can retry.
      if (ctx.ackState === "nacked") {
        return;
      }
      if (nackInFlight) {
        await nackInFlight;
        return;
      }
      nackInFlight = (async () => {
        await params.onNack?.(error);
        ctx.ackState = "nacked";
        ctx.nackErrorMessage = formatErrorMessage(error);
      })();
      try {
        await nackInFlight;
      } finally {
        nackInFlight = undefined;
      }
    },
  };
  return ctx;
}
