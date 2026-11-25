// Public reply adapters remove host-only event custody before entering core.
import {
  dispatchInboundMessage as dispatchInboundMessageInternal,
  dispatchInboundMessageWithBufferedDispatcher as dispatchInboundMessageWithBufferedDispatcherInternal,
  dispatchInboundMessageWithDispatcher as dispatchInboundMessageWithDispatcherInternal,
} from "../auto-reply/dispatch.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { getReplyFromConfig as getReplyFromConfigInternal } from "../auto-reply/reply/get-reply.js";
import { publicChannelTurn, publicReplyOptions, type PublicReplyParams } from "./reply-options.js";

export function dispatchInboundMessageForSdk(
  params: PublicReplyParams<Parameters<typeof dispatchInboundMessageInternal>[0]>,
) {
  return dispatchInboundMessageInternal(publicChannelTurn(params));
}
export function dispatchInboundMessageWithBufferedDispatcherForSdk(
  params: PublicReplyParams<
    Parameters<typeof dispatchInboundMessageWithBufferedDispatcherInternal>[0]
  >,
) {
  return dispatchInboundMessageWithBufferedDispatcherInternal(publicChannelTurn(params));
}
export function dispatchInboundMessageWithDispatcherForSdk(
  params: PublicReplyParams<Parameters<typeof dispatchInboundMessageWithDispatcherInternal>[0]>,
) {
  return dispatchInboundMessageWithDispatcherInternal(publicChannelTurn(params));
}
export function getReplyFromConfigForSdk(
  ctx: Parameters<typeof getReplyFromConfigInternal>[0],
  opts?: GetReplyOptions,
  config?: Parameters<typeof getReplyFromConfigInternal>[2],
) {
  return getReplyFromConfigInternal(ctx, publicReplyOptions(opts), config);
}
