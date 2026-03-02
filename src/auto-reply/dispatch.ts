import type { OpenClawConfig } from "../config/config.js";
import { emitMessageSentHook } from "../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions, ReplyPayload } from "./types.js";

export type DispatchInboundResult = DispatchFromConfigResult;

export type MessageSentHookContext = {
  sessionKey?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

export function createMessageSentHookHandler(ctx: MessageSentHookContext) {
  return (payload: ReplyPayload) => {
    const { sessionKey, channelId, accountId, conversationId } = ctx;
    const content = payload.text ?? "";
    if (sessionKey) {
      emitMessageSentHook({
        sessionKey,
        to: conversationId ?? "",
        content,
        success: true,
        channelId,
        accountId,
        conversationId,
      });
    }
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("message_sent")) {
      void hookRunner
        .runMessageSent(
          {
            to: conversationId ?? "",
            content,
            success: true,
          },
          {
            channelId,
            accountId,
            conversationId,
          },
        )
        .catch(() => {});
    }
  };
}

export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    // Ensure dispatcher reservations are always released on every exit path.
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        ctx: finalized,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
        replyResolver: params.replyResolver,
      }),
  });
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );
  try {
    return await dispatchInboundMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
      },
    });
  } finally {
    markDispatchIdle();
  }
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);
  return await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
