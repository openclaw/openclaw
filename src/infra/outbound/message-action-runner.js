import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { readNumberParam, readStringArrayParam, readStringParam, } from "../../agents/tools/common.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import { hasInteractiveReplyBlocks, hasMessagePresentationBlocks, hasReplyPayloadContent, normalizeMessagePresentation, } from "../../interactive/payload.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { hasPollCreationParams } from "../../poll-params.js";
import { resolvePollMaxSelections } from "../../polls.js";
import { buildChannelAccountBindings } from "../../routing/bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, } from "../../utils/message-channel.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import { listConfiguredMessageChannels, resolveMessageChannelSelection, } from "./channel-selection.js";
import { normalizeMessageActionInput } from "./message-action-normalization.js";
import { collectActionMediaSourceHints, hydrateAttachmentParamsForAction, normalizeSandboxMediaList, normalizeSandboxMediaParams, parseInteractiveParam, parseJsonMessageParam, readBooleanParam, resolveAttachmentMediaPolicy, resolveExtraActionMediaSourceParamKeys, } from "./message-action-params.js";
import { prepareOutboundMirrorRoute, resolveAndApplyOutboundReplyToId, resolveAndApplyOutboundThreadId, } from "./message-action-threading.js";
import { applyCrossContextDecoration, buildCrossContextDecoration, enforceCrossContextPolicy, shouldApplyCrossContextMarker, } from "./outbound-policy.js";
import { executePollAction, executeSendAction } from "./outbound-send-service.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";
import { resolveChannelTarget } from "./target-resolver.js";
import { extractToolPayload } from "./tool-payload.js";
let messageActionGatewayRuntimePromise = null;
function loadMessageActionGatewayRuntime() {
    messageActionGatewayRuntimePromise ??= import("./message.gateway.runtime.js");
    return messageActionGatewayRuntimePromise;
}
export function getToolResult(result) {
    return "toolResult" in result ? result.toolResult : undefined;
}
function resolveGatewayActionOptions(gateway) {
    return {
        url: gateway?.url,
        token: gateway?.token,
        timeoutMs: typeof gateway?.timeoutMs === "number" && Number.isFinite(gateway.timeoutMs)
            ? Math.max(1, Math.floor(gateway.timeoutMs))
            : 10_000,
        clientName: gateway?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
        clientDisplayName: gateway?.clientDisplayName,
        mode: gateway?.mode ?? GATEWAY_CLIENT_MODES.CLI,
    };
}
async function callGatewayMessageAction(params) {
    const { callGatewayLeastPrivilege } = await loadMessageActionGatewayRuntime();
    const gateway = resolveGatewayActionOptions(params.gateway);
    return await callGatewayLeastPrivilege({
        url: gateway.url,
        token: gateway.token,
        method: "message.action",
        params: params.actionParams,
        timeoutMs: gateway.timeoutMs,
        clientName: gateway.clientName,
        clientDisplayName: gateway.clientDisplayName,
        mode: gateway.mode,
    });
}
async function resolveGatewayActionIdempotencyKey(idempotencyKey) {
    if (idempotencyKey) {
        return idempotencyKey;
    }
    const { randomIdempotencyKey } = await loadMessageActionGatewayRuntime();
    return randomIdempotencyKey();
}
function applyCrossContextMessageDecoration({ params, message, decoration, preferPresentation, }) {
    const applied = applyCrossContextDecoration({
        message,
        decoration,
        preferPresentation,
    });
    params.message = applied.message;
    if (applied.presentation) {
        const existing = normalizeMessagePresentation(params.presentation);
        params.presentation = existing
            ? {
                ...existing,
                blocks: [...applied.presentation.blocks, ...existing.blocks],
            }
            : applied.presentation;
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
        preferPresentation: params.preferPresentation,
    });
}
async function resolveChannel(cfg, params, toolContext) {
    const selection = await resolveMessageChannelSelection({
        cfg,
        channel: readStringParam(params, "channel"),
        fallbackChannel: toolContext?.currentChannelProvider,
    });
    if (selection.source === "tool-context-fallback") {
        params.channel = selection.channel;
    }
    return selection.channel;
}
async function resolveActionTarget(params) {
    let resolvedTarget;
    const toRaw = normalizeOptionalString(params.args.to) ?? "";
    if (toRaw) {
        const resolved = await resolveResolvedTargetOrThrow({
            cfg: params.cfg,
            channel: params.channel,
            input: toRaw,
            accountId: params.accountId ?? undefined,
        });
        params.args.to = resolved.to;
        resolvedTarget = resolved;
    }
    const channelIdRaw = normalizeOptionalString(params.args.channelId) ?? "";
    if (channelIdRaw) {
        const resolved = await resolveResolvedTargetOrThrow({
            cfg: params.cfg,
            channel: params.channel,
            input: channelIdRaw,
            accountId: params.accountId ?? undefined,
            preferredKind: "group",
            validateResolvedTarget: (target) => target.kind === "user"
                ? `Channel id "${channelIdRaw}" resolved to a user target.`
                : undefined,
        });
        params.args.channelId = sanitizeGroupTargetId(resolved.to);
    }
    return resolvedTarget;
}
function sanitizeGroupTargetId(target) {
    return target.replace(/^(channel|group):/i, "");
}
async function resolveResolvedTargetOrThrow(params) {
    const resolved = await resolveChannelTarget({
        cfg: params.cfg,
        channel: params.channel,
        input: params.input,
        accountId: params.accountId,
        preferredKind: params.preferredKind,
    });
    if (!resolved.ok) {
        throw resolved.error;
    }
    const validationError = params.validateResolvedTarget?.(resolved.target);
    if (validationError) {
        throw new Error(validationError);
    }
    return resolved.target;
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
    const rawTargets = readStringArrayParam(params, "targets", { required: true });
    if (rawTargets.length === 0) {
        throw new Error("Broadcast requires at least one target in --targets.");
    }
    const channelHint = readStringParam(params, "channel");
    const targetChannels = channelHint && normalizeOptionalLowercaseString(channelHint) !== "all"
        ? [await resolveChannel(input.cfg, { channel: channelHint }, input.toolContext)]
        : await (async () => {
            const configured = await listConfiguredMessageChannels(input.cfg);
            if (configured.length === 0) {
                throw new Error("Broadcast requires at least one configured channel.");
            }
            return configured;
        })();
    const results = [];
    const isAbortError = (err) => err instanceof Error && err.name === "AbortError";
    for (const targetChannel of targetChannels) {
        throwIfAborted(input.abortSignal);
        for (const target of rawTargets) {
            throwIfAborted(input.abortSignal);
            try {
                const resolved = await resolveResolvedTargetOrThrow({
                    cfg: input.cfg,
                    channel: targetChannel,
                    input: target,
                });
                const sendResult = await runMessageAction({
                    ...input,
                    action: "send",
                    params: {
                        ...params,
                        channel: targetChannel,
                        target: resolved.to,
                    },
                });
                results.push({
                    channel: targetChannel,
                    to: resolved.to,
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
                    error: formatErrorMessage(err),
                });
            }
        }
    }
    return {
        kind: "broadcast",
        channel: targetChannels[0] ?? normalizeOptionalLowercaseString(channelHint) ?? "unknown",
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
    if (params.pin === true && params.delivery == null) {
        params.delivery = { pin: { enabled: true } };
    }
    // Support media, path, and filePath parameters for attachments
    const mediaHint = readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "mediaUrl", { trim: false }) ??
        readStringParam(params, "path", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false }) ??
        readStringParam(params, "fileUrl", { trim: false });
    const hasPresentation = hasMessagePresentationBlocks(params.presentation);
    const hasInteractive = hasInteractiveReplyBlocks(params.interactive);
    const caption = readStringParam(params, "caption", { allowEmpty: true }) ?? "";
    let message = readStringParam(params, "message", {
        required: !mediaHint && !hasPresentation && !hasInteractive,
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
        const trimmed = normalizeOptionalString(value);
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
        preferPresentation: true,
    });
    const mediaUrl = readStringParam(params, "media", { trim: false });
    if (!hasReplyPayloadContent({
        text: message,
        mediaUrl,
        mediaUrls: mergedMediaUrls,
        presentation: params.presentation,
        interactive: params.interactive,
    })) {
        throw new Error("send requires text or media");
    }
    params.message = message;
    const gifPlayback = readBooleanParam(params, "gifPlayback") ?? false;
    const forceDocument = readBooleanParam(params, "forceDocument") ?? readBooleanParam(params, "asDocument") ?? false;
    const bestEffort = readBooleanParam(params, "bestEffort");
    const silent = readBooleanParam(params, "silent");
    const replyToId = resolveAndApplyOutboundReplyToId(params, {
        channel,
        toolContext: input.toolContext,
    });
    const { resolvedThreadId, outboundRoute } = await prepareOutboundMirrorRoute({
        cfg,
        channel,
        to,
        actionParams: params,
        accountId,
        toolContext: input.toolContext,
        agentId,
        currentSessionKey: input.sessionKey,
        dryRun,
        resolvedTarget,
        resolveAutoThreadId: getChannelPlugin(channel)?.threading?.resolveAutoThreadId,
        resolveOutboundSessionRoute,
        ensureOutboundSessionEntry,
    });
    const mirrorMediaUrls = mergedMediaUrls.length > 0 ? mergedMediaUrls : mediaUrl ? [mediaUrl] : undefined;
    throwIfAborted(abortSignal);
    const send = await executeSendAction({
        ctx: {
            cfg,
            channel,
            params,
            agentId,
            sessionKey: input.sessionKey,
            requesterAccountId: input.requesterAccountId ?? undefined,
            requesterSenderId: input.requesterSenderId ?? undefined,
            requesterSenderName: input.requesterSenderName ?? undefined,
            requesterSenderUsername: input.requesterSenderUsername ?? undefined,
            requesterSenderE164: input.requesterSenderE164 ?? undefined,
            mediaAccess: ctx.mediaAccess,
            accountId: accountId ?? undefined,
            senderIsOwner: input.senderIsOwner,
            sessionId: input.sessionId,
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
        forceDocument,
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
    const { cfg, params, channel, accountId, dryRun, gateway, input, agentId, abortSignal } = ctx;
    throwIfAborted(abortSignal);
    const action = "poll";
    const to = readStringParam(params, "to", { required: true });
    const silent = readBooleanParam(params, "silent");
    const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
        cfg,
        to,
        accountId,
        toolContext: input.toolContext,
        resolveAutoThreadId: getChannelPlugin(channel)?.threading?.resolveAutoThreadId,
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
        preferPresentation: false,
    });
    const poll = await executePollAction({
        ctx: {
            cfg,
            channel,
            params,
            accountId: accountId ?? undefined,
            agentId,
            requesterSenderId: input.requesterSenderId ?? undefined,
            senderIsOwner: input.senderIsOwner,
            sessionKey: input.sessionKey,
            sessionId: input.sessionId,
            gateway,
            toolContext: input.toolContext,
            dryRun,
            silent: silent ?? undefined,
        },
        resolveCorePoll: () => {
            const question = readStringParam(params, "pollQuestion", {
                required: true,
            });
            const options = readStringArrayParam(params, "pollOption", { required: true });
            if (options.length < 2) {
                throw new Error("pollOption requires at least two values");
            }
            const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
            const durationHours = readNumberParam(params, "pollDurationHours", {
                integer: true,
                strict: true,
            });
            return {
                to,
                question,
                options,
                maxSelections: resolvePollMaxSelections(options.length, allowMultiselect),
                durationHours: durationHours ?? undefined,
                threadId: resolvedThreadId ?? undefined,
            };
        },
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
    const { cfg, params, channel, mediaAccess, accountId, dryRun, gateway, input, abortSignal, agentId, } = ctx;
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
    const plugin = resolveOutboundChannelPlugin({ channel, cfg });
    if (!plugin?.actions?.handleAction) {
        throw new Error(`Channel ${channel} is unavailable for message actions (plugin not loaded).`);
    }
    const executionMode = plugin.actions.resolveExecutionMode?.({ action }) ?? "local";
    if (executionMode === "gateway" && gateway) {
        // Gateway-owned actions must execute where the live channel runtime exists.
        const payload = await callGatewayMessageAction({
            gateway,
            actionParams: {
                channel,
                action,
                params,
                accountId: accountId ?? undefined,
                requesterSenderId: input.requesterSenderId ?? undefined,
                senderIsOwner: input.senderIsOwner,
                sessionKey: input.sessionKey,
                sessionId: input.sessionId,
                agentId,
                toolContext: input.toolContext,
                idempotencyKey: await resolveGatewayActionIdempotencyKey(normalizeOptionalString(params.idempotencyKey)),
            },
        });
        return {
            kind: "action",
            channel,
            action,
            handledBy: "plugin",
            payload,
            dryRun,
        };
    }
    const handled = await dispatchChannelMessageAction({
        channel,
        action,
        cfg,
        params,
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile: mediaAccess.readFile,
        accountId: accountId ?? undefined,
        requesterSenderId: input.requesterSenderId ?? undefined,
        senderIsOwner: input.senderIsOwner,
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
        agentId,
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
    let params = { ...input.params };
    const resolvedAgentId = input.agentId ??
        (input.sessionKey
            ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: cfg })
            : undefined);
    parseJsonMessageParam(params, "presentation");
    parseJsonMessageParam(params, "delivery");
    parseInteractiveParam(params);
    const action = input.action;
    if (action === "broadcast") {
        return handleBroadcastAction(input, params);
    }
    params = normalizeMessageActionInput({
        action,
        args: params,
        toolContext: input.toolContext,
    });
    const channel = await resolveChannel(cfg, params, input.toolContext);
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
    const normalizationPolicy = resolveAttachmentMediaPolicy({
        sandboxRoot: input.sandboxRoot,
        mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, resolvedAgentId),
    });
    const extraActionMediaSourceParamKeys = resolveExtraActionMediaSourceParamKeys({
        cfg,
        action,
        args: params,
        channel,
        accountId,
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
        agentId: resolvedAgentId,
        requesterSenderId: input.requesterSenderId,
        senderIsOwner: input.senderIsOwner,
    });
    await normalizeSandboxMediaParams({
        args: params,
        mediaPolicy: normalizationPolicy,
        extraParamKeys: extraActionMediaSourceParamKeys,
    });
    const mediaAccess = resolveAgentScopedOutboundMediaAccess({
        cfg,
        agentId: resolvedAgentId,
        mediaSources: collectActionMediaSourceHints(params, extraActionMediaSourceParamKeys),
        sessionKey: input.sessionKey,
        messageProvider: input.sessionKey ? undefined : channel,
        accountId: input.sessionKey ? (input.requesterAccountId ?? accountId) : accountId,
        requesterSenderId: input.requesterSenderId,
        requesterSenderName: input.requesterSenderName,
        requesterSenderUsername: input.requesterSenderUsername,
        requesterSenderE164: input.requesterSenderE164,
    });
    const mediaPolicy = resolveAttachmentMediaPolicy({
        sandboxRoot: input.sandboxRoot,
        mediaAccess,
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
    if (action === "send" && hasPollCreationParams(params)) {
        throw new Error('Poll fields require action "poll"; use action "poll" instead of "send".');
    }
    const gateway = resolveGateway(input);
    if (action === "send") {
        return handleSendAction({
            cfg,
            params,
            channel,
            mediaAccess,
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
            mediaAccess,
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
        mediaAccess,
        accountId,
        dryRun,
        gateway,
        input,
        agentId: resolvedAgentId,
        abortSignal: input.abortSignal,
    });
}
