import { readStringParam } from "../../agents/tools/common.js";
export function resolveAndApplyOutboundThreadId(actionParams, context) {
    const threadId = readStringParam(actionParams, "threadId");
    const resolved = threadId ??
        context.resolveAutoThreadId?.({
            cfg: context.cfg,
            accountId: context.accountId,
            to: context.to,
            toolContext: context.toolContext,
            replyToId: readStringParam(actionParams, "replyTo"),
        });
    if (resolved && !actionParams.threadId) {
        actionParams.threadId = resolved;
    }
    return resolved ?? undefined;
}
function isSameConversationTarget(actionParams, channel, toolContext) {
    const currentChannelId = toolContext?.currentChannelId?.trim();
    if (!currentChannelId) {
        return false;
    }
    const currentChannelProvider = toolContext?.currentChannelProvider?.trim();
    if (currentChannelProvider && currentChannelProvider !== channel) {
        return false;
    }
    const explicitTarget = readStringParam(actionParams, "target") ??
        readStringParam(actionParams, "to") ??
        readStringParam(actionParams, "channelId");
    if (!explicitTarget) {
        return true;
    }
    return explicitTarget.trim() === currentChannelId;
}
export function resolveAndApplyOutboundReplyToId(actionParams, context) {
    const explicitReplyToId = readStringParam(actionParams, "replyTo");
    if (explicitReplyToId) {
        if (context.toolContext?.replyToMode === "first") {
            const hasRepliedRef = context.toolContext.hasRepliedRef;
            if (hasRepliedRef) {
                hasRepliedRef.value = true;
            }
        }
        return explicitReplyToId;
    }
    if (!isSameConversationTarget(actionParams, context.channel, context.toolContext)) {
        return undefined;
    }
    const currentMessageId = context.toolContext?.currentMessageId;
    if (currentMessageId == null) {
        return undefined;
    }
    const mode = context.toolContext?.replyToMode ?? "off";
    if (mode === "off" || mode === "batched") {
        return undefined;
    }
    if (mode === "first") {
        const hasRepliedRef = context.toolContext?.hasRepliedRef;
        if (hasRepliedRef?.value) {
            return undefined;
        }
        if (hasRepliedRef) {
            hasRepliedRef.value = true;
        }
    }
    const resolvedReplyToId = typeof currentMessageId === "number" ? String(currentMessageId) : currentMessageId.trim();
    if (!resolvedReplyToId) {
        return undefined;
    }
    actionParams.replyTo = resolvedReplyToId;
    return resolvedReplyToId;
}
export async function prepareOutboundMirrorRoute(params) {
    const replyToId = readStringParam(params.actionParams, "replyTo");
    const resolvedThreadId = resolveAndApplyOutboundThreadId(params.actionParams, {
        cfg: params.cfg,
        to: params.to,
        accountId: params.accountId,
        toolContext: params.toolContext,
        resolveAutoThreadId: params.resolveAutoThreadId,
    });
    const outboundRoute = params.agentId && !params.dryRun
        ? await params.resolveOutboundSessionRoute({
            cfg: params.cfg,
            channel: params.channel,
            agentId: params.agentId,
            accountId: params.accountId,
            target: params.to,
            currentSessionKey: params.currentSessionKey,
            resolvedTarget: params.resolvedTarget,
            replyToId,
            threadId: resolvedThreadId,
        })
        : null;
    if (outboundRoute && params.agentId && !params.dryRun) {
        await params.ensureOutboundSessionEntry({
            cfg: params.cfg,
            channel: params.channel,
            accountId: params.accountId,
            route: outboundRoute,
        });
    }
    if (outboundRoute && !params.dryRun) {
        params.actionParams.__sessionKey = outboundRoute.sessionKey;
    }
    if (params.agentId) {
        params.actionParams.__agentId = params.agentId;
    }
    return {
        resolvedThreadId,
        outboundRoute,
    };
}
