import { dispatchChannelMessageAction } from "../../channels/plugins/message-actions.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { throwIfAborted } from "./abort.js";
import { sendMessage, sendPoll } from "./message.js";
import { extractToolPayload } from "./tool-payload.js";
async function tryHandleWithPluginAction(params) {
    if (params.ctx.dryRun) {
        return null;
    }
    const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.ctx.cfg, params.ctx.agentId ?? params.ctx.mirror?.agentId);
    const handled = await dispatchChannelMessageAction({
        channel: params.ctx.channel,
        action: params.action,
        cfg: params.ctx.cfg,
        params: params.ctx.params,
        mediaLocalRoots,
        accountId: params.ctx.accountId ?? undefined,
        gateway: params.ctx.gateway,
        toolContext: params.ctx.toolContext,
        dryRun: params.ctx.dryRun,
    });
    if (!handled) {
        return null;
    }
    await params.onHandled?.();
    return {
        handledBy: "plugin",
        payload: extractToolPayload(handled),
        toolResult: handled,
    };
}
export async function executeSendAction(params) {
    throwIfAborted(params.ctx.abortSignal);
    const pluginHandled = await tryHandleWithPluginAction({
        ctx: params.ctx,
        action: "send",
        onHandled: async () => {
            if (!params.ctx.mirror) {
                return;
            }
            const mirrorText = params.ctx.mirror.text ?? params.message;
            const mirrorMediaUrls = params.ctx.mirror.mediaUrls ??
                params.mediaUrls ??
                (params.mediaUrl ? [params.mediaUrl] : undefined);
            await appendAssistantMessageToSessionTranscript({
                agentId: params.ctx.mirror.agentId,
                sessionKey: params.ctx.mirror.sessionKey,
                text: mirrorText,
                mediaUrls: mirrorMediaUrls,
            });
        },
    });
    if (pluginHandled) {
        return pluginHandled;
    }
    throwIfAborted(params.ctx.abortSignal);
    const result = await sendMessage({
        cfg: params.ctx.cfg,
        to: params.to,
        content: params.message,
        agentId: params.ctx.agentId,
        mediaUrl: params.mediaUrl || undefined,
        mediaUrls: params.mediaUrls,
        channel: params.ctx.channel || undefined,
        accountId: params.ctx.accountId ?? undefined,
        replyToId: params.replyToId,
        threadId: params.threadId,
        gifPlayback: params.gifPlayback,
        dryRun: params.ctx.dryRun,
        bestEffort: params.bestEffort ?? undefined,
        deps: params.ctx.deps,
        gateway: params.ctx.gateway,
        mirror: params.ctx.mirror,
        abortSignal: params.ctx.abortSignal,
        silent: params.ctx.silent,
    });
    return {
        handledBy: "core",
        payload: result,
        sendResult: result,
    };
}
export async function executePollAction(params) {
    const pluginHandled = await tryHandleWithPluginAction({
        ctx: params.ctx,
        action: "poll",
    });
    if (pluginHandled) {
        return pluginHandled;
    }
    const result = await sendPoll({
        cfg: params.ctx.cfg,
        to: params.to,
        question: params.question,
        options: params.options,
        maxSelections: params.maxSelections,
        durationSeconds: params.durationSeconds ?? undefined,
        durationHours: params.durationHours ?? undefined,
        channel: params.ctx.channel,
        accountId: params.ctx.accountId ?? undefined,
        threadId: params.threadId ?? undefined,
        silent: params.ctx.silent ?? undefined,
        isAnonymous: params.isAnonymous ?? undefined,
        dryRun: params.ctx.dryRun,
        gateway: params.ctx.gateway,
    });
    return {
        handledBy: "core",
        payload: result,
        pollResult: result,
    };
}
