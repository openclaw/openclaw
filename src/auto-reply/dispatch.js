import { normalizeChatType } from "../channels/chat-type.js";
import { deriveInboundMessageHookContext, toPluginMessageContext, } from "../hooks/message-hook-mappers.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { withReplyDispatcher } from "./dispatch-dispatcher.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import { createReplyDispatcher, createReplyDispatcherWithTyping, } from "./reply/reply-dispatcher.js";
function resolveDispatcherSilentReplyContext(ctx, cfg) {
    const finalized = finalizeInboundContext(ctx);
    const policySessionKey = finalized.CommandSource === "native"
        ? (finalized.CommandTargetSessionKey ?? finalized.SessionKey)
        : finalized.SessionKey;
    const chatType = normalizeChatType(finalized.ChatType);
    const conversationType = finalized.CommandSource === "native" &&
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
function resolveInboundReplyHookTarget(finalized, hookCtx) {
    if (typeof finalized.OriginatingTo === "string" && finalized.OriginatingTo.trim()) {
        return finalized.OriginatingTo;
    }
    if (hookCtx.isGroup) {
        return hookCtx.conversationId ?? hookCtx.to ?? hookCtx.from;
    }
    return hookCtx.from || hookCtx.conversationId || hookCtx.to || "";
}
function buildMessageSendingBeforeDeliver(ctx) {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("message_sending")) {
        return undefined;
    }
    const finalized = finalizeInboundContext(ctx);
    const hookCtx = deriveInboundMessageHookContext(finalized);
    const replyTarget = resolveInboundReplyHookTarget(finalized, hookCtx);
    return async (payload) => {
        if (!payload.text) {
            return payload;
        }
        const result = await hookRunner.runMessageSending({ content: payload.text, to: replyTarget }, toPluginMessageContext(hookCtx));
        if (result?.cancel) {
            return null;
        }
        if (result?.content != null) {
            return { ...payload, text: result.content };
        }
        return payload;
    };
}
export { withReplyDispatcher } from "./dispatch-dispatcher.js";
function finalizeDispatchResult(result, dispatcher) {
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
export async function dispatchInboundMessage(params) {
    const finalized = finalizeInboundContext(params.ctx);
    const result = await withReplyDispatcher({
        dispatcher: params.dispatcher,
        run: () => dispatchReplyFromConfig({
            ctx: finalized,
            cfg: params.cfg,
            dispatcher: params.dispatcher,
            replyOptions: params.replyOptions,
            replyResolver: params.replyResolver,
        }),
    });
    return finalizeDispatchResult(result, params.dispatcher);
}
export async function dispatchInboundMessageWithBufferedDispatcher(params) {
    const silentReplyContext = resolveDispatcherSilentReplyContext(params.ctx, params.cfg);
    const beforeDeliver = params.dispatcherOptions.beforeDeliver ?? buildMessageSendingBeforeDeliver(params.ctx);
    const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } = createReplyDispatcherWithTyping({
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
    }
    finally {
        markRunComplete();
        markDispatchIdle();
    }
}
export async function dispatchInboundMessageWithDispatcher(params) {
    const silentReplyContext = resolveDispatcherSilentReplyContext(params.ctx, params.cfg);
    const dispatcher = createReplyDispatcher({
        ...params.dispatcherOptions,
        beforeDeliver: params.dispatcherOptions.beforeDeliver ?? buildMessageSendingBeforeDeliver(params.ctx),
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
