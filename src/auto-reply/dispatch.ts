import type { OpenClawConfig } from "../config/config.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";

export type DispatchInboundResult = DispatchFromConfigResult;

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  return await dispatchReplyFromConfig({
    ctx: finalized,
    cfg: params.cfg,
    dispatcher: params.dispatcher,
    replyOptions: params.replyOptions,
    replyResolver: params.replyResolver,
  });
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  // Inject session context for message:sent hooks
  const dispatcherOptionsWithContext: ReplyDispatcherWithTypingOptions = {
    ...params.dispatcherOptions,
    sessionKey: params.dispatcherOptions.sessionKey ?? finalized.SessionKey,
    channel:
      params.dispatcherOptions.channel ??
      (finalized.OriginatingChannel ?? finalized.Surface ?? finalized.Provider ?? "").toLowerCase(),
    chatType: params.dispatcherOptions.chatType ?? finalized.ChatType,
  };
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    dispatcherOptionsWithContext,
  );

  const result = await dispatchInboundMessage({
    ctx: finalized,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: {
      ...params.replyOptions,
      ...replyOptions,
    },
  });

  markDispatchIdle();
  return result;
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  // Inject session context for message:sent hooks
  const dispatcherOptionsWithContext: ReplyDispatcherOptions = {
    ...params.dispatcherOptions,
    sessionKey: params.dispatcherOptions.sessionKey ?? finalized.SessionKey,
    channel:
      params.dispatcherOptions.channel ??
      (finalized.OriginatingChannel ?? finalized.Surface ?? finalized.Provider ?? "").toLowerCase(),
    chatType: params.dispatcherOptions.chatType ?? finalized.ChatType,
  };
  const dispatcher = createReplyDispatcher(dispatcherOptionsWithContext);
  const result = await dispatchInboundMessage({
    ctx: finalized,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
  await dispatcher.waitForIdle();
  return result;
}
