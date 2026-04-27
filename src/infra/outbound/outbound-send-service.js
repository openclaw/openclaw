import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { throwIfAborted } from "./abort.js";
import { sendMessage, sendPoll } from "./message.js";
import { extractToolPayload } from "./tool-payload.js";
function collectActionMediaSources(params) {
    const sources = [];
    for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl"]) {
        const value = params[key];
        if (typeof value === "string" && value.trim()) {
            sources.push(value);
        }
    }
    return sources;
}
async function tryHandleWithPluginAction(params) {
    if (params.ctx.dryRun) {
        return null;
    }
    const mediaAccess = resolveAgentScopedOutboundMediaAccess({
        cfg: params.ctx.cfg,
        agentId: params.ctx.agentId ?? params.ctx.mirror?.agentId,
        mediaSources: collectActionMediaSources(params.ctx.params),
        sessionKey: params.ctx.sessionKey,
        messageProvider: params.ctx.sessionKey ? undefined : params.ctx.channel,
        accountId: (params.ctx.sessionKey
            ? (params.ctx.requesterAccountId ?? params.ctx.accountId)
            : params.ctx.accountId) ?? undefined,
        requesterSenderId: params.ctx.requesterSenderId,
        requesterSenderName: params.ctx.requesterSenderName,
        requesterSenderUsername: params.ctx.requesterSenderUsername,
        requesterSenderE164: params.ctx.requesterSenderE164,
        mediaAccess: params.ctx.mediaAccess,
        mediaReadFile: params.ctx.mediaReadFile,
    });
    const handled = await dispatchChannelMessageAction({
        channel: params.ctx.channel,
        action: params.action,
        cfg: params.ctx.cfg,
        params: params.ctx.params,
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile: mediaAccess.readFile,
        accountId: params.ctx.accountId ?? undefined,
        requesterSenderId: params.ctx.requesterSenderId,
        senderIsOwner: params.ctx.senderIsOwner,
        sessionKey: params.ctx.sessionKey,
        sessionId: params.ctx.sessionId,
        agentId: params.ctx.agentId,
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
                idempotencyKey: params.ctx.mirror.idempotencyKey,
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
        requesterSessionKey: params.ctx.sessionKey,
        requesterAccountId: params.ctx.requesterAccountId ?? params.ctx.accountId ?? undefined,
        requesterSenderId: params.ctx.requesterSenderId,
        requesterSenderName: params.ctx.requesterSenderName,
        requesterSenderUsername: params.ctx.requesterSenderUsername,
        requesterSenderE164: params.ctx.requesterSenderE164,
        mediaUrl: params.mediaUrl || undefined,
        mediaUrls: params.mediaUrls,
        channel: params.ctx.channel || undefined,
        accountId: params.ctx.accountId ?? undefined,
        replyToId: params.replyToId,
        threadId: params.threadId,
        gifPlayback: params.gifPlayback,
        forceDocument: params.forceDocument,
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
    const corePoll = params.resolveCorePoll();
    const result = await sendPoll({
        cfg: params.ctx.cfg,
        to: corePoll.to,
        question: corePoll.question,
        options: corePoll.options,
        maxSelections: corePoll.maxSelections,
        durationSeconds: corePoll.durationSeconds ?? undefined,
        durationHours: corePoll.durationHours ?? undefined,
        channel: params.ctx.channel,
        accountId: params.ctx.accountId ?? undefined,
        threadId: corePoll.threadId ?? undefined,
        silent: params.ctx.silent ?? undefined,
        isAnonymous: corePoll.isAnonymous ?? undefined,
        dryRun: params.ctx.dryRun,
        gateway: params.ctx.gateway,
    });
    return {
        handledBy: "core",
        payload: result,
        pollResult: result,
    };
}
