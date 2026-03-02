import { normalizeChannelId } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
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
import type { GetReplyOptions } from "./types.js";

export type DispatchInboundResult = DispatchFromConfigResult;

type DispatcherDeliveredParams = Parameters<NonNullable<ReplyDispatcherOptions["onDelivered"]>>[0];

function resolveDispatcherMessageSentContext(ctx: FinalizedMsgContext): {
  channelId: string;
  to: string;
  accountId?: string;
  sessionKey?: string;
} | null {
  const rawChannel = ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider;
  const channelId =
    typeof rawChannel === "string" && rawChannel.trim()
      ? (normalizeChannelId(rawChannel) ?? rawChannel.trim())
      : undefined;
  const toRaw =
    (typeof ctx.OriginatingTo === "string" && ctx.OriginatingTo.trim()) ||
    (typeof ctx.To === "string" && ctx.To.trim()) ||
    undefined;
  if (!channelId || !toRaw) {
    return null;
  }
  const accountId =
    typeof ctx.AccountId === "string" && ctx.AccountId.trim() ? ctx.AccountId.trim() : undefined;
  const sessionKey =
    (typeof ctx.SessionKey === "string" && ctx.SessionKey.trim()) ||
    (typeof ctx.CommandTargetSessionKey === "string" && ctx.CommandTargetSessionKey.trim()) ||
    undefined;
  return {
    channelId,
    to: toRaw,
    accountId,
    sessionKey,
  };
}

function emitDispatcherMessageSentHook(params: {
  context: {
    channelId: string;
    to: string;
    accountId?: string;
    sessionKey?: string;
  };
  delivered: DispatcherDeliveredParams;
}) {
  if (params.delivered.payload.isReasoning) {
    return;
  }
  const content =
    typeof params.delivered.payload.text === "string" ? params.delivered.payload.text : "";
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_sent")) {
    void hookRunner
      .runMessageSent(
        {
          to: params.context.to,
          content,
          success: params.delivered.success,
          ...(params.delivered.error ? { error: params.delivered.error } : {}),
        },
        {
          channelId: params.context.channelId,
          accountId: params.context.accountId,
          conversationId: params.context.to,
        },
      )
      .catch(() => {});
  }

  if (!params.context.sessionKey) {
    return;
  }
  void triggerInternalHook(
    createInternalHookEvent("message", "sent", params.context.sessionKey, {
      to: params.context.to,
      content,
      success: params.delivered.success,
      ...(params.delivered.error ? { error: params.delivered.error } : {}),
      channelId: params.context.channelId,
      accountId: params.context.accountId,
      conversationId: params.context.to,
    }),
  ).catch(() => {});
}

function withDispatcherMessageSentHook<
  T extends { onDelivered?: (params: DispatcherDeliveredParams) => void },
>(options: T, ctx: FinalizedMsgContext): T {
  const messageSentContext = resolveDispatcherMessageSentContext(ctx);
  if (!messageSentContext) {
    return options;
  }
  const existingOnDelivered = options.onDelivered;
  return {
    ...options,
    onDelivered: (params) => {
      existingOnDelivered?.(params);
      emitDispatcherMessageSentHook({
        context: messageSentContext,
        delivered: params,
      });
    },
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
  const finalized = finalizeInboundContext(params.ctx);
  const dispatcherOptions = withDispatcherMessageSentHook(params.dispatcherOptions, finalized);
  const { dispatcher, replyOptions, markDispatchIdle } =
    createReplyDispatcherWithTyping(dispatcherOptions);
  try {
    return await dispatchInboundMessage({
      ctx: finalized,
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
  const finalized = finalizeInboundContext(params.ctx);
  const dispatcher = createReplyDispatcher(
    withDispatcherMessageSentHook(params.dispatcherOptions, finalized),
  );
  return await dispatchInboundMessage({
    ctx: finalized,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
