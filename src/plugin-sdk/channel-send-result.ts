import type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
import type { ChannelPollResult } from "../channels/plugins/types.public.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";

export type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
export type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";

/** Legacy raw send result shape accepted from channel SDK adapters. */
export type ChannelSendRawResult = {
  ok: boolean;
  messageId?: string | null;
  error?: string | null;
};

/** Attaches the channel id to a single outbound send result. */
export function attachChannelToResult<T extends object>(
  /** Stable channel id stamped on outbound delivery results. */
  channel: string,
  /** Channel-specific result payload; its fields are preserved after the channel stamp. */
  result: T,
) {
  return {
    channel,
    ...result,
  };
}

/** Attaches the channel id to each outbound send result in order. */
export function attachChannelToResults<T extends object>(channel: string, results: readonly T[]) {
  return results.map((result) => attachChannelToResult(channel, result));
}

/** Creates an empty outbound delivery result for send paths that produced no platform id. */
export function createEmptyChannelResult(
  /** Stable channel id for the outbound path that could not produce a platform message id. */
  channel: string,
  /** Optional delivery metadata such as chat/thread ids; messageId defaults to the legacy sentinel. */
  result: Partial<Omit<OutboundDeliveryResult, "channel" | "messageId">> & {
    messageId?: string;
  } = {},
): OutboundDeliveryResult {
  // Empty message ids are the legacy "no platform id" sentinel expected by outbound callers.
  return attachChannelToResult(channel, {
    messageId: "",
    ...result,
  });
}

type MaybePromise<T> = T | Promise<T>;
type SendTextParams = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];
type SendMediaParams = Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0];
type SendPollParams = Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0];

/** Wraps outbound send methods that already return delivery-shaped results without channel ids. */
export function createAttachedChannelResultAdapter(params: {
  /** Channel id added to every wrapped send result. */
  channel: string;
  /** Modern text sender returning outbound delivery fields except channel. */
  sendText?: (ctx: SendTextParams) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
  /** Modern media sender returning outbound delivery fields except channel. */
  sendMedia?: (ctx: SendMediaParams) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
  /** Modern poll sender returning poll delivery fields except channel. */
  sendPoll?: (ctx: SendPollParams) => MaybePromise<Omit<ChannelPollResult, "channel">>;
}): Pick<ChannelOutboundAdapter, "sendText" | "sendMedia" | "sendPoll"> {
  return {
    sendText: params.sendText
      ? async (ctx) => attachChannelToResult(params.channel, await params.sendText!(ctx))
      : undefined,
    sendMedia: params.sendMedia
      ? async (ctx) => attachChannelToResult(params.channel, await params.sendMedia!(ctx))
      : undefined,
    sendPoll: params.sendPoll
      ? async (ctx) => attachChannelToResult(params.channel, await params.sendPoll!(ctx))
      : undefined,
  };
}

/** Wraps legacy raw text/media send methods and normalizes their results. */
export function createRawChannelSendResultAdapter(params: {
  /** Channel id added while converting raw ok/messageId/error payloads. */
  channel: string;
  /** Legacy text sender that reports primitive success/error fields. */
  sendText?: (ctx: SendTextParams) => MaybePromise<ChannelSendRawResult>;
  /** Legacy media sender that reports primitive success/error fields. */
  sendMedia?: (ctx: SendMediaParams) => MaybePromise<ChannelSendRawResult>;
}): Pick<ChannelOutboundAdapter, "sendText" | "sendMedia"> {
  return {
    sendText: params.sendText
      ? async (ctx) => buildChannelSendResult(params.channel, await params.sendText!(ctx))
      : undefined,
    sendMedia: params.sendMedia
      ? async (ctx) => buildChannelSendResult(params.channel, await params.sendMedia!(ctx))
      : undefined,
  };
}

/** Normalize raw channel send results into the shape shared outbound callers expect. */
export function buildChannelSendResult(
  /** Channel id for the adapter that produced the raw send result. */
  channel: string,
  /** Legacy primitive result; null/undefined message ids map to the empty-id sentinel. */
  result: ChannelSendRawResult,
) {
  return {
    channel,
    ok: result.ok,
    messageId: result.messageId ?? "",
    error: result.error ? new Error(result.error) : undefined,
  };
}
