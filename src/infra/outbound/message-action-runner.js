import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { readNumberParam, readStringArrayParam, readStringParam, } from "../../agents/tools/common.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-actions.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { buildChannelAccountBindings } from "../../routing/bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isDeliverableMessageChannel, normalizeMessageChannel, } from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import { listConfiguredMessageChannels, resolveMessageChannelSelection, } from "./channel-selection.js";
import { applyTargetToParams } from "./channel-target.js";
import { hydrateAttachmentParamsForAction, normalizeSandboxMediaList, normalizeSandboxMediaParams, parseButtonsParam, parseCardParam, parseComponentsParam, readBooleanParam, resolveAttachmentMediaPolicy, resolveSlackAutoThreadId, resolveTelegramAutoThreadId, } from "./message-action-params.js";
import { actionHasTarget, actionRequiresTarget } from "./message-action-spec.js";
import { applyCrossContextDecoration, buildCrossContextDecoration, enforceCrossContextPolicy, shouldApplyCrossContextMarker, } from "./outbound-policy.js";
import { executePollAction, executeSendAction } from "./outbound-send-service.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";
import { resolveChannelTarget } from "./target-resolver.js";
import { extractToolPayload } from "./tool-payload.js";
function resolveAndApplyOutboundThreadId(params, ctx) {
    const threadId = readStringParam(params, "threadId");
    const slackAutoThreadId = ctx.allowSlackAutoThread && ctx.channel === "slack" && !threadId
        ? resolveSlackAutoThreadId({ to: ctx.to, toolContext: ctx.toolContext })
        : undefined;
    const telegramAutoThreadId = ctx.channel === "telegram" && !threadId
        ? resolveTelegramAutoThreadId({ to: ctx.to, toolContext: ctx.toolContext })
        : undefined;
    const resolved = threadId ?? slackAutoThreadId ?? telegramAutoThreadId;
    // Write auto-resolved threadId back into params so downstream dispatch
    // (plugin `readStringParam(params, "threadId")`) picks it up.
    if (resolved && !params.threadId) {
        params.threadId = resolved;
    }
    return resolved ?? undefined;
}
export function getToolResult(result) {
    return "toolResult" in result ? result.toolResult : undefined;
}
function applyCrossContextMessageDecoration({ params, message, decoration, preferComponents, }) {
    const applied = applyCrossContextDecoration({
        message,
        decoration,
        preferComponents,
    });
    params.message = applied.message;
    if (applied.componentsBuilder) {
        params.components = applied.componentsBuilder;
    }
    return applied.message;
}
async function maybeApplyCrossContextMarker(params) {
    if (!shouldApplyCrossContextMarker(params.action) || !params.toolContext) {
        return params.message;
    }
    const decoration = await buildCrossContextDecoration({
        cfg: params.cfg,
        channel: params.channel,
        target: params.target,
        toolContext: params.toolContext,
        accountId: params.accountId ?? undefined,
    });
    if (!decoration) {
        return params.message;
    }
    return applyCrossContextMessageDecoration({
        params: params.args,
        message: params.message,
        decoration,
        preferComponents: params.preferComponents,
    });
}
async function resolveChannel(cfg, params) {
    const channelHint = readStringParam(params, "channel");
    const selection = await resolveMessageChannelSelection({
        cfg,
        channel: channelHint,
    });
    return selection.channel;
}
async function resolveActionTarget(params) {
    let resolvedTarget;
    const toRaw = typeof params.args.to === "string" ? params.args.to.trim() : "";
    if (toRaw) {
        const resolved = await resolveChannelTarget({
            cfg: params.cfg,
            channel: params.channel,
            input: toRaw,
            accountId: params.accountId ?? undefined,
        });
        if (resolved.ok) {
            params.args.to = resolved.target.to;
            resolvedTarget = resolved.target;
        }
        else {
            throw resolved.error;
        }
    }
    const channelIdRaw = typeof params.args.channelId === "string" ? params.args.channelId.trim() : "";
    if (channelIdRaw) {
        const resolved = await resolveChannelTarget({
            cfg: params.cfg,
            channel: params.channel,
            input: channelIdRaw,
            accountId: params.accountId ?? undefined,
            preferredKind: "group",
        });
        if (resolved.ok) {
            if (resolved.target.kind === "user") {
                throw new Error(`Channel id "${channelIdRaw}" resolved to a user target.`);
            }
            params.args.channelId = resolved.target.to.replace(/^(channel|group):/i, "");
        }
        else {
            throw resolved.error;
        }
    }
    return resolvedTarget;
}
function resolveGateway(input) {
    if (!input.gateway) {
        return undefined;
    }
    return {
        url: input.gateway.url,
        token: input.gateway.token,
        timeoutMs: input.gateway.timeoutMs,
        clientName: input.gateway.clientName,
        clientDisplayName: input.gateway.clientDisplayName,
        mode: input.gateway.mode,
    };
}
async function handleBroadcastAction(input, params) {
    throwIfAborted(input.abortSignal);
    const broadcastEnabled = input.cfg.tools?.message?.broadcast?.enabled !== false;
    if (!broadcastEnabled) {
        throw new Error("Broadcast is disabled. Set tools.message.broadcast.enabled to true.");
    }
    const rawTargets = readStringArrayParam(params, "targets", { required: true }) ?? [];
    if (rawTargets.length === 0) {
        throw new Error("Broadcast requires at least one target in --targets.");
    }
    const channelHint = readStringParam(params, "channel");
    const configured = await listConfiguredMessageChannels(input.cfg);
    if (configured.length === 0) {
        throw new Error("Broadcast requires at least one configured channel.");
    }
    const targetChannels = channelHint && channelHint.trim().toLowerCase() !== "all"
        ? [await resolveChannel(input.cfg, { channel: channelHint })]
        : configured;
    const results = [];
    const isAbortError = (err) => err instanceof Error && err.name === "AbortError";
    for (const targetChannel of targetChannels) {
        throwIfAborted(input.abortSignal);
        for (const target of rawTargets) {
            throwIfAborted(input.abortSignal);
            try {
                const resolved = await resolveChannelTarget({
                    cfg: input.cfg,
                    channel: targetChannel,
                    input: target,
                });
                if (!resolved.ok) {
                    throw resolved.error;
                }
                const sendResult = await runMessageAction({
                    ...input,
                    action: "send",
                    params: {
                        ...params,
                        channel: targetChannel,
                        target: resolved.target.to,
                    },
                });
                results.push({
                    channel: targetChannel,
                    to: resolved.target.to,
                    ok: true,
                    result: sendResult.kind === "send" ? sendResult.sendResult : undefined,
                });
            }
            catch (err) {
                if (isAbortError(err)) {
                    throw err;
                }
                results.push({
                    channel: targetChannel,
                    to: target,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    return {
        kind: "broadcast",
        channel: targetChannels[0] ?? "discord",
        action: "broadcast",
        handledBy: input.dryRun ? "dry-run" : "core",
        payload: { results },
        dryRun: Boolean(input.dryRun),
    };
}
async function handleSendAction(ctx) {
    const { cfg, params, channel, accountId, dryRun, gateway, input, agentId, resolvedTarget, abortSignal, } = ctx;
    throwIfAborted(abortSignal);
    const action = "send";
    const to = readStringParam(params, "to", { required: true });
    // Support media, path, and filePath parameters for attachments
    const mediaHint = readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "path", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false });
    const hasCard = params.card != null && typeof params.card === "object";
    const hasComponents = params.components != null && typeof params.components === "object";
    const caption = readStringParam(params, "caption", { allowEmpty: true }) ?? "";
    let message = readStringParam(params, "message", {
        required: !mediaHint && !hasCard && !hasComponents,
        allowEmpty: true,
    }) ?? "";
    if (message.includes("\\n")) {
        message = message.replaceAll("\\n", "\n");
    }
    if (!message.trim() && caption.trim()) {
        message = caption;
    }
    const parsed = parseReplyDirectives(message);
    const mergedMediaUrls = [];
    const seenMedia = new Set();
    const pushMedia = (value) => {
        const trimmed = value?.trim();
        if (!trimmed) {
            return;
        }
        if (seenMedia.has(trimmed)) {
            return;
        }
        seenMedia.add(trimmed);
        mergedMediaUrls.push(trimmed);
    };
    pushMedia(mediaHint);
    for (const url of parsed.mediaUrls ?? []) {
        pushMedia(url);
    }
    pushMedia(parsed.mediaUrl);
    const normalizedMediaUrls = await normalizeSandboxMediaList({
        values: mergedMediaUrls,
        sandboxRoot: input.sandboxRoot,
    });
    mergedMediaUrls.length = 0;
    mergedMediaUrls.push(...normalizedMediaUrls);
    message = parsed.text;
    params.message = message;
    if (!params.replyTo && parsed.replyToId) {
        params.replyTo = parsed.replyToId;
    }
    if (!params.media) {
        // Use path/filePath if media not set, then fall back to parsed directives
        params.media = mergedMediaUrls[0] || undefined;
    }
    message = await maybeApplyCrossContextMarker({
        cfg,
        channel,
        action,
        target: to,
        toolContext: input.toolContext,
        accountId,
        args: params,
        message,
        preferComponents: true,
    });
    const mediaUrl = readStringParam(params, "media", { trim: false });
    if (channel === "whatsapp") {
        message = message.replace(/^(?:[ \t]*\r?\n)+/, "");
        if (!message.trim()) {
            message = "";
        }
    }
    if (!message.trim() && !mediaUrl && mergedMediaUrls.length === 0 && !hasCard && !hasComponents) {
        throw new Error("send requires text or media");
    }
    params.message = message;
    const gifPlayback = readBooleanParam(params, "gifPlayback") ?? false;
    const bestEffort = readBooleanParam(params, "bestEffort");
    const silent = readBooleanParam(params, "silent");
    const replyToId = readStringParam(params, "replyTo");
    const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
        channel,
        to,
        toolContext: input.toolContext,
        allowSlackAutoThread: channel === "slack" && !replyToId,
    });
    const outboundRoute = agentId && !dryRun
        ? await resolveOutboundSessionRoute({
            cfg,
            channel,
            agentId,
            accountId,
            target: to,
            resolvedTarget,
            replyToId,
            threadId: resolvedThreadId,
        })
        : null;
    if (outboundRoute && agentId && !dryRun) {
        await ensureOutboundSessionEntry({
            cfg,
            agentId,
            channel,
            accountId,
            route: outboundRoute,
        });
    }
    if (outboundRoute && !dryRun) {
        params.__sessionKey = outboundRoute.sessionKey;
    }
    if (agentId) {
        params.__agentId = agentId;
    }
    const mirrorMediaUrls = mergedMediaUrls.length > 0 ? mergedMediaUrls : mediaUrl ? [mediaUrl] : undefined;
    throwIfAborted(abortSignal);
    const send = await executeSendAction({
        ctx: {
            cfg,
            channel,
            params,
            agentId,
            accountId: accountId ?? undefined,
            gateway,
            toolContext: input.toolContext,
            deps: input.deps,
            dryRun,
            mirror: outboundRoute && !dryRun
                ? {
                    sessionKey: outboundRoute.sessionKey,
                    agentId,
                    text: message,
                    mediaUrls: mirrorMediaUrls,
                }
                : undefined,
            abortSignal,
            silent: silent ?? undefined,
        },
        to,
        message,
        mediaUrl: mediaUrl || undefined,
        mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
        gifPlayback,
        bestEffort: bestEffort ?? undefined,
        replyToId: replyToId ?? undefined,
        threadId: resolvedThreadId ?? undefined,
    });
    return {
        kind: "send",
        channel,
        action,
        to,
        handledBy: send.handledBy,
        payload: send.payload,
        toolResult: send.toolResult,
        sendResult: send.sendResult,
        dryRun,
    };
}
async function handlePollAction(ctx) {
    const { cfg, params, channel, accountId, dryRun, gateway, input, abortSignal } = ctx;
    throwIfAborted(abortSignal);
    const action = "poll";
    const to = readStringParam(params, "to", { required: true });
    const question = readStringParam(params, "pollQuestion", {
        required: true,
    });
    const options = readStringArrayParam(params, "pollOption", { required: true }) ?? [];
    if (options.length < 2) {
        throw new Error("pollOption requires at least two values");
    }
    const silent = readBooleanParam(params, "silent");
    const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
    const pollAnonymous = readBooleanParam(params, "pollAnonymous");
    const pollPublic = readBooleanParam(params, "pollPublic");
    if (pollAnonymous && pollPublic) {
        throw new Error("pollAnonymous and pollPublic are mutually exclusive");
    }
    const isAnonymous = pollAnonymous ? true : pollPublic ? false : undefined;
    const durationHours = readNumberParam(params, "pollDurationHours", {
        integer: true,
    });
    const durationSeconds = readNumberParam(params, "pollDurationSeconds", {
        integer: true,
    });
    const maxSelections = allowMultiselect ? Math.max(2, options.length) : 1;
    if (durationSeconds !== undefined && channel !== "telegram") {
        throw new Error("pollDurationSeconds is only supported for Telegram polls");
    }
    if (isAnonymous !== undefined && channel !== "telegram") {
        throw new Error("pollAnonymous/pollPublic are only supported for Telegram polls");
    }
    const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
        channel,
        to,
        toolContext: input.toolContext,
        allowSlackAutoThread: channel === "slack",
    });
    const base = typeof params.message === "string" ? params.message : "";
    await maybeApplyCrossContextMarker({
        cfg,
        channel,
        action,
        target: to,
        toolContext: input.toolContext,
        accountId,
        args: params,
        message: base,
        preferComponents: false,
    });
    const poll = await executePollAction({
        ctx: {
            cfg,
            channel,
            params,
            accountId: accountId ?? undefined,
            gateway,
            toolContext: input.toolContext,
            dryRun,
            silent: silent ?? undefined,
        },
        to,
        question,
        options,
        maxSelections,
        durationSeconds: durationSeconds ?? undefined,
        durationHours: durationHours ?? undefined,
        threadId: resolvedThreadId ?? undefined,
        isAnonymous,
    });
    return {
        kind: "poll",
        channel,
        action,
        to,
        handledBy: poll.handledBy,
        payload: poll.payload,
        toolResult: poll.toolResult,
        pollResult: poll.pollResult,
        dryRun,
    };
}
async function handlePluginAction(ctx) {
    const { cfg, params, channel, accountId, dryRun, gateway, input, abortSignal } = ctx;
    throwIfAborted(abortSignal);
    const action = input.action;
    if (dryRun) {
        return {
            kind: "action",
            channel,
            action,
            handledBy: "dry-run",
            payload: { ok: true, dryRun: true, channel, action },
            dryRun: true,
        };
    }
    const handled = await dispatchChannelMessageAction({
        channel,
        action,
        cfg,
        params,
        accountId: accountId ?? undefined,
        requesterSenderId: input.requesterSenderId ?? undefined,
        gateway,
        toolContext: input.toolContext,
        dryRun,
    });
    if (!handled) {
        throw new Error(`Message action ${action} not supported for channel ${channel}.`);
    }
    return {
        kind: "action",
        channel,
        action,
        handledBy: "plugin",
        payload: extractToolPayload(handled),
        toolResult: handled,
        dryRun,
    };
}
export async function runMessageAction(input) {
    const cfg = input.cfg;
    const params = { ...input.params };
    const resolvedAgentId = input.agentId ??
        (input.sessionKey
            ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: cfg })
            : undefined);
    parseButtonsParam(params);
    parseCardParam(params);
    parseComponentsParam(params);
    const action = input.action;
    if (action === "broadcast") {
        return handleBroadcastAction(input, params);
    }
    const explicitTarget = typeof params.target === "string" ? params.target.trim() : "";
    const hasLegacyTarget = (typeof params.to === "string" && params.to.trim().length > 0) ||
        (typeof params.channelId === "string" && params.channelId.trim().length > 0);
    if (explicitTarget && hasLegacyTarget) {
        delete params.to;
        delete params.channelId;
    }
    if (!explicitTarget &&
        !hasLegacyTarget &&
        actionRequiresTarget(action) &&
        !actionHasTarget(action, params)) {
        const inferredTarget = input.toolContext?.currentChannelId?.trim();
        if (inferredTarget) {
            params.target = inferredTarget;
        }
    }
    if (!explicitTarget && actionRequiresTarget(action) && hasLegacyTarget) {
        const legacyTo = typeof params.to === "string" ? params.to.trim() : "";
        const legacyChannelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
        const legacyTarget = legacyTo || legacyChannelId;
        if (legacyTarget) {
            params.target = legacyTarget;
            delete params.to;
            delete params.channelId;
        }
    }
    const explicitChannel = typeof params.channel === "string" ? params.channel.trim() : "";
    if (!explicitChannel) {
        const inferredChannel = normalizeMessageChannel(input.toolContext?.currentChannelProvider);
        if (inferredChannel && isDeliverableMessageChannel(inferredChannel)) {
            params.channel = inferredChannel;
        }
    }
    applyTargetToParams({ action, args: params });
    if (actionRequiresTarget(action)) {
        if (!actionHasTarget(action, params)) {
            throw new Error(`Action ${action} requires a target.`);
        }
    }
    const channel = await resolveChannel(cfg, params);
    let accountId = readStringParam(params, "accountId") ?? input.defaultAccountId;
    if (!accountId && resolvedAgentId) {
        const byAgent = buildChannelAccountBindings(cfg).get(channel);
        const boundAccountIds = byAgent?.get(normalizeAgentId(resolvedAgentId));
        if (boundAccountIds && boundAccountIds.length > 0) {
            accountId = boundAccountIds[0];
        }
    }
    if (accountId) {
        params.accountId = accountId;
    }
    const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
    const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, resolvedAgentId);
    const mediaPolicy = resolveAttachmentMediaPolicy({
        sandboxRoot: input.sandboxRoot,
        mediaLocalRoots,
    });
    await normalizeSandboxMediaParams({
        args: params,
        mediaPolicy,
    });
    await hydrateAttachmentParamsForAction({
        cfg,
        channel,
        accountId,
        args: params,
        action,
        dryRun,
        mediaPolicy,
    });
    const resolvedTarget = await resolveActionTarget({
        cfg,
        channel,
        action,
        args: params,
        accountId,
    });
    enforceCrossContextPolicy({
        channel,
        action,
        args: params,
        toolContext: input.toolContext,
        cfg,
    });
    const gateway = resolveGateway(input);
    if (action === "send") {
        return handleSendAction({
            cfg,
            params,
            channel,
            accountId,
            dryRun,
            gateway,
            input,
            agentId: resolvedAgentId,
            resolvedTarget,
            abortSignal: input.abortSignal,
        });
    }
    if (action === "poll") {
        return handlePollAction({
            cfg,
            params,
            channel,
            accountId,
            dryRun,
            gateway,
            input,
            abortSignal: input.abortSignal,
        });
    }
    return handlePluginAction({
        cfg,
        params,
        channel,
        accountId,
        dryRun,
        gateway,
        input,
        abortSignal: input.abortSignal,
    });
}
