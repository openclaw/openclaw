import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  deriveInboundMessageHookContext,
  toPluginMessageContext,
} from "../hooks/message-hook-mappers.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { SilentReplyConversationType } from "../shared/silent-reply-policy.js";
import { withReplyDispatcher } from "./dispatch-dispatcher.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.types.js";
import type { GetReplyFromConfig } from "./reply/get-reply.types.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatchBeforeDeliver,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions, ReplyPayload } from "./types.js";

/**
 * 解析调度器的静默回复上下文
 * 根据消息上下文和配置确定静默回复策略
 * @param ctx - 消息上下文
 * @param cfg - OpenClaw配置
 * @returns 包含会话键、表面类型和会话类型的静默回复上下文
 */
function resolveDispatcherSilentReplyContext(
  ctx: MsgContext | FinalizedMsgContext,
  cfg: OpenClawConfig,
) {
  const finalized = finalizeInboundContext(ctx);
  const policySessionKey =
    finalized.CommandSource === "native"
      ? (finalized.CommandTargetSessionKey ?? finalized.SessionKey)
      : finalized.SessionKey;
  const chatType = normalizeChatType(finalized.ChatType);
  const conversationType: SilentReplyConversationType | undefined =
    finalized.CommandSource === "native" &&
    finalized.CommandTargetSessionKey &&
    finalized.CommandTargetSessionKey !== finalized.SessionKey
      ? undefined
      : chatType === "direct"
        ? "direct"
        : chatType === "group" || chatType === "channel"
          ? "group"
          : undefined;
  return {
    cfg,
    sessionKey: policySessionKey,
    surface: finalized.Surface ?? finalized.Provider,
    conversationType,
  };
}

/**
 * 解析入站回复钩子的目标地址
 * @param finalized - 完成了的入站上下文
 * @param hookCtx - 钩子上下文
 * @returns 消息发送目标地址
 */
function resolveInboundReplyHookTarget(
  finalized: FinalizedMsgContext,
  hookCtx: ReturnType<typeof deriveInboundMessageHookContext>,
): string {
  if (typeof finalized.OriginatingTo === "string" && finalized.OriginatingTo.trim()) {
    return finalized.OriginatingTo;
  }
  if (hookCtx.isGroup) {
    return hookCtx.conversationId ?? hookCtx.to ?? hookCtx.from;
  }
  return hookCtx.from || hookCtx.conversationId || hookCtx.to || "";
}

/**
 * 构建消息发送前的钩子处理函数
 * @param ctx - 消息上下文
 * @returns 在消息发送前调用的钩子函数，或undefined
 */
function buildMessageSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
): ReplyDispatchBeforeDeliver | undefined {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return undefined;
  }

  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  const replyTarget = resolveInboundReplyHookTarget(finalized, hookCtx);

  return async (payload: ReplyPayload): Promise<ReplyPayload | null> => {
    if (!payload.text) {
      return payload;
    }

    const result = await hookRunner.runMessageSending(
      { content: payload.text, to: replyTarget },
      toPluginMessageContext(hookCtx),
    );

    if (result?.cancel) {
      return null;
    }
    if (result?.content != null) {
      return { ...payload, text: result.content };
    }
    return payload;
  };
}

/**
 * 调度入站消息的结果类型
 */
export type DispatchInboundResult = DispatchFromConfigResult;

/**
 * 导出调度器辅助函数
 */
export { withReplyDispatcher } from "./dispatch-dispatcher.js";

/**
 * 完成调度结果，计算取消后的最终计数
 * @param result - 原始调度结果
 * @param dispatcher - 回复调度器
 * @returns 更新了计数的结果
 */
function finalizeDispatchResult(
  result: DispatchFromConfigResult,
  dispatcher: ReplyDispatcher,
): DispatchFromConfigResult {
  const cancelledCounts = dispatcher.getCancelledCounts?.();
  if (!cancelledCounts) {
    return result;
  }

  const counts = {
    tool: Math.max(0, result.counts.tool - cancelledCounts.tool),
    block: Math.max(0, result.counts.block - cancelledCounts.block),
    final: Math.max(0, result.counts.final - cancelledCounts.final),
  };
  return {
    queuedFinal: result.queuedFinal && counts.final > 0,
    counts,
  };
}

/**
 * 调度入站消息
 * @param params - 包含消息上下文、配置、调度器和选项的参数
 * @returns 调度结果
 */
export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  const result = await withReplyDispatcher({
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
  return finalizeDispatchResult(result, params.dispatcher);
}

/**
 * 使用缓冲调度器调度入站消息
 * 创建一个带缓冲的调度器，支持打字状态
 * @param params - 包含消息上下文、配置、调度器选项和回复选项的参数
 * @returns 调度结果
 */
export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const silentReplyContext = resolveDispatcherSilentReplyContext(params.ctx, params.cfg);
  const beforeDeliver =
    params.dispatcherOptions.beforeDeliver ?? buildMessageSendingBeforeDeliver(params.ctx);
  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    createReplyDispatcherWithTyping({
      ...params.dispatcherOptions,
      beforeDeliver,
      silentReplyContext: params.dispatcherOptions.silentReplyContext ?? silentReplyContext,
    });
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
    markRunComplete();
    markDispatchIdle();
  }
}

/**
 * 使用指定调度器调度入站消息
 * @param params - 包含消息上下文、配置、调度器选项和回复选项的参数
 * @returns 调度结果
 */
export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const silentReplyContext = resolveDispatcherSilentReplyContext(params.ctx, params.cfg);
  const dispatcher = createReplyDispatcher({
    ...params.dispatcherOptions,
    beforeDeliver:
      params.dispatcherOptions.beforeDeliver ?? buildMessageSendingBeforeDeliver(params.ctx),
    silentReplyContext: params.dispatcherOptions.silentReplyContext ?? silentReplyContext,
  });
  return await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
