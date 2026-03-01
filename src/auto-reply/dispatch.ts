import type { OpenClawConfig } from "../config/config.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type DeliveryQueueContext,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";

export type DispatchInboundResult = DispatchFromConfigResult;

export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}

type DispatchInboundMessageInternalParams = {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
};

function resolveDeliveryQueueContext(params: {
  ctx: FinalizedMsgContext;
}): DeliveryQueueContext | undefined {
  const channel = normalizeMessageChannel(
    params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
  );
  if (!channel || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  const to = params.ctx.OriginatingTo?.trim() || params.ctx.To?.trim();
  if (!to) {
    return undefined;
  }
  return {
    channel,
    to,
    accountId: params.ctx.AccountId?.trim() || undefined,
    threadId: params.ctx.MessageThreadId,
    replyToId: params.ctx.ReplyToId?.trim() || undefined,
    turnId: params.ctx.MessageTurnId,
  };
}

async function dispatchInboundMessageInternal({
  ctx,
  cfg,
  dispatcher,
  replyOptions,
  replyResolver,
}: DispatchInboundMessageInternalParams): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(ctx);

  // Interaction-scoped dispatchers (Slack slash /openclaw, Discord native commands)
  // use one-time callbacks (respond(), interaction.reply()) that cannot survive
  // recovery. Skip outbox tracking for these to avoid replaying content to the
  // wrong destination (e.g. DM fallback when the original callback has expired).
  const isInteractionScoped = finalized.CommandSource === "native";

  if (dispatcher.setDeliveryQueueContext && !isInteractionScoped) {
    const queueContext = resolveDeliveryQueueContext({ ctx: finalized });
    dispatcher.setDeliveryQueueContext(queueContext);
  }

  return await withReplyDispatcher({
    dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        ctx: finalized,
        cfg,
        dispatcher,
        replyOptions,
        replyResolver,
      }),
  });
}

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  return dispatchInboundMessageInternal(params);
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
    return await dispatchInboundMessageInternal({
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
  return await dispatchInboundMessageInternal({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
