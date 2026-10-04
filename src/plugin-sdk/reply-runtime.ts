// Shared agent/reply runtime helpers for channel plugins. Keep channel plugins
// off direct src/auto-reply imports by routing common reply primitives here.

import {
  dispatchInboundMessageInternal,
  dispatchInboundMessageWithBufferedDispatcherInternal,
  dispatchInboundMessageWithDispatcherInternal,
} from "../auto-reply/dispatch.js";
import { getReplyFromConfigInternal } from "../auto-reply/reply/get-reply.js";
import {
  publicReplyOptions,
  type GetReplyOptions,
  type PublicReplyParams,
} from "./reply-options.js";

export {
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
export type { ChunkMode } from "../auto-reply/chunk.js";
export { settleReplyDispatcher } from "../auto-reply/dispatch.js";
export function dispatchInboundMessage(
  params: PublicReplyParams<Parameters<typeof dispatchInboundMessageInternal>[0]>,
) {
  return dispatchInboundMessageInternal({
    ...params,
    replyOptions: publicReplyOptions(params.replyOptions),
  });
}
export function dispatchInboundMessageWithBufferedDispatcher(
  params: PublicReplyParams<
    Parameters<typeof dispatchInboundMessageWithBufferedDispatcherInternal>[0]
  >,
) {
  return dispatchInboundMessageWithBufferedDispatcherInternal({
    ...params,
    replyOptions: publicReplyOptions(params.replyOptions),
  });
}
export function dispatchInboundMessageWithDispatcher(
  params: PublicReplyParams<Parameters<typeof dispatchInboundMessageWithDispatcherInternal>[0]>,
) {
  return dispatchInboundMessageWithDispatcherInternal({
    ...params,
    replyOptions: publicReplyOptions(params.replyOptions),
  });
}
export {
  normalizeGroupActivation,
  parseActivationCommand,
} from "../auto-reply/group-activation.js";
export function getReplyFromConfig(
  ctx: Parameters<typeof getReplyFromConfigInternal>[0],
  opts?: GetReplyOptions,
  config?: Parameters<typeof getReplyFromConfigInternal>[2],
) {
  return getReplyFromConfigInternal(ctx, publicReplyOptions(opts), config);
}
export { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
export { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
export { isBtwRequestText } from "../auto-reply/reply/btw-command.js";
export { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
export { finalizeInboundContextForSdk as finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
export {
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchReplyWithDispatcher,
} from "./reply-dispatch-runtime.js";
export {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
} from "../auto-reply/reply/reply-dispatcher.js";
export type {
  ReplyDispatchBeforeDeliverOptions,
  ReplyDispatchKind,
  ReplyDispatchRuntimeInfo,
  ReplyDispatcher,
  ReplyFollowupAdmissionBarrierTimeoutPolicy,
} from "../auto-reply/reply/reply-dispatcher.types.js";
export type {
  ReplyDispatcherOptions,
  ReplyDispatcherWithTypingOptions,
} from "../auto-reply/reply/reply-dispatcher.js";
export { createReplyReferencePlanner } from "../auto-reply/reply/reply-reference.js";
export type {
  BlockReplyContext,
  SourceReplyDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
export type { GetReplyOptions } from "./reply-options.js";
export type { ReplyPayload } from "./reply-payload.js";
export type {
  ChannelStructuredContextEntry,
  FinalizedMsgContext,
  MsgContext,
  UntrustedStructuredContextEntry,
} from "../auto-reply/templating.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";
export { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
export type { ConversationLabelParams } from "../auto-reply/reply/conversation-label-generator.js";
