import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { buildCanonicalSentMessageHookContext, toInternalMessageSentContext, toPluginMessageContext, toPluginMessageSentEvent, } from "../../hooks/message-hook-mappers.js";
import { hasReplyPayloadContent, normalizeMessagePresentation, renderMessagePresentationFallbackText, } from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { diagnosticErrorCategory } from "../diagnostic-error-metadata.js";
import { emitDiagnosticEvent } from "../diagnostic-events.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { ackDelivery, enqueueDelivery, failDelivery, withActiveDeliveryClaim, } from "./delivery-queue.js";
import { planOutboundMediaMessageUnits, planOutboundTextMessageUnits, } from "./message-plan.js";
import { createOutboundPayloadPlan, projectOutboundPayloadPlanForDelivery, summarizeOutboundPayloadForTransport, } from "./payloads.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";
export { normalizeOutboundPayloads } from "./payloads.js";
export { resolveOutboundSendDep } from "./send-deps.js";
const log = createSubsystemLogger("outbound/deliver");
let transcriptRuntimePromise;
async function loadTranscriptRuntime() {
    transcriptRuntimePromise ??= import("../../config/sessions/transcript.runtime.js");
    return await transcriptRuntimePromise;
}
let channelBootstrapRuntimePromise;
async function loadChannelBootstrapRuntime() {
    channelBootstrapRuntimePromise ??= import("./channel-bootstrap.runtime.js");
    return await channelBootstrapRuntimePromise;
}
// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function createChannelHandler(params) {
    let outbound = await loadChannelOutboundAdapter(params.channel);
    if (!outbound) {
        const { bootstrapOutboundChannelPlugin } = await loadChannelBootstrapRuntime();
        bootstrapOutboundChannelPlugin({
            channel: params.channel,
            cfg: params.cfg,
        });
        outbound = await loadChannelOutboundAdapter(params.channel);
    }
    const handler = createPluginHandler({ ...params, outbound });
    if (!handler) {
        throw new Error(`Outbound not configured for channel: ${params.channel}`);
    }
    return handler;
}
function createPluginHandler(params) {
    const outbound = params.outbound;
    if (!outbound?.sendText) {
        return null;
    }
    const baseCtx = createChannelOutboundContextBase(params);
    const sendText = outbound.sendText;
    const sendMedia = outbound.sendMedia;
    const chunker = outbound.chunker ?? null;
    const chunkerMode = outbound.chunkerMode;
    const resolveCtx = (overrides) => ({
        ...baseCtx,
        replyToId: overrides && "replyToId" in overrides ? overrides.replyToId : baseCtx.replyToId,
        replyToIdSource: overrides && "replyToIdSource" in overrides
            ? overrides.replyToIdSource
            : baseCtx.replyToIdSource,
        threadId: overrides && "threadId" in overrides ? overrides.threadId : baseCtx.threadId,
        audioAsVoice: overrides?.audioAsVoice,
    });
    const buildTargetRef = (overrides) => ({
        channel: params.channel,
        to: params.to,
        accountId: params.accountId ?? undefined,
        threadId: overrides?.threadId ?? baseCtx.threadId,
    });
    return {
        chunker,
        chunkerMode,
        textChunkLimit: outbound.textChunkLimit,
        supportsMedia: Boolean(sendMedia),
        sanitizeText: outbound.sanitizeText
            ? (payload) => outbound.sanitizeText({ text: payload.text ?? "", payload })
            : undefined,
        normalizePayload: outbound.normalizePayload
            ? (payload) => outbound.normalizePayload({ payload })
            : undefined,
        renderPresentation: outbound.renderPresentation
            ? async (payload) => {
                const presentation = normalizeMessagePresentation(payload.presentation);
                if (!presentation) {
                    return payload;
                }
                const ctx = {
                    ...resolveCtx({
                        replyToId: payload.replyToId ?? baseCtx.replyToId,
                        threadId: baseCtx.threadId,
                        audioAsVoice: payload.audioAsVoice,
                    }),
                    text: payload.text ?? "",
                    mediaUrl: payload.mediaUrl,
                    payload,
                };
                return await outbound.renderPresentation({ payload, presentation, ctx });
            }
            : undefined,
        pinDeliveredMessage: outbound.pinDeliveredMessage
            ? async ({ target, messageId, pin }) => outbound.pinDeliveredMessage({
                cfg: params.cfg,
                target,
                messageId,
                pin,
            })
            : undefined,
        afterDeliverPayload: outbound.afterDeliverPayload
            ? async ({ target, payload, results }) => outbound.afterDeliverPayload({
                cfg: params.cfg,
                target,
                payload,
                results,
            })
            : undefined,
        shouldSkipPlainTextSanitization: outbound.shouldSkipPlainTextSanitization
            ? (payload) => outbound.shouldSkipPlainTextSanitization({ payload })
            : undefined,
        resolveEffectiveTextChunkLimit: outbound.resolveEffectiveTextChunkLimit
            ? (fallbackLimit) => outbound.resolveEffectiveTextChunkLimit({
                cfg: params.cfg,
                accountId: params.accountId ?? undefined,
                fallbackLimit,
            })
            : undefined,
        sendPayload: outbound.sendPayload
            ? async (payload, overrides) => outbound.sendPayload({
                ...resolveCtx(overrides),
                text: payload.text ?? "",
                mediaUrl: payload.mediaUrl,
                payload,
            })
            : undefined,
        sendFormattedText: outbound.sendFormattedText
            ? async (text, overrides) => outbound.sendFormattedText({
                ...resolveCtx(overrides),
                text,
            })
            : undefined,
        sendFormattedMedia: outbound.sendFormattedMedia
            ? async (caption, mediaUrl, overrides) => outbound.sendFormattedMedia({
                ...resolveCtx(overrides),
                text: caption,
                mediaUrl,
            })
            : undefined,
        sendText: async (text, overrides) => sendText({
            ...resolveCtx(overrides),
            text,
        }),
        buildTargetRef,
        sendMedia: async (caption, mediaUrl, overrides) => {
            if (sendMedia) {
                return sendMedia({
                    ...resolveCtx(overrides),
                    text: caption,
                    mediaUrl,
                });
            }
            return sendText({
                ...resolveCtx(overrides),
                text: caption,
            });
        },
    };
}
function createChannelOutboundContextBase(params) {
    return {
        cfg: params.cfg,
        to: params.to,
        accountId: params.accountId,
        replyToId: params.replyToId,
        replyToMode: params.replyToMode,
        formatting: params.formatting,
        threadId: params.threadId,
        identity: params.identity,
        gifPlayback: params.gifPlayback,
        forceDocument: params.forceDocument,
        deps: params.deps,
        silent: params.silent,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaAccess?.localRoots,
        mediaReadFile: params.mediaAccess?.readFile,
        gatewayClientScopes: params.gatewayClientScopes,
    };
}
const isAbortError = (err) => err instanceof Error && err.name === "AbortError";
function collectPayloadMediaSources(plan) {
    return plan.flatMap((entry) => entry.parts.mediaUrls);
}
function sessionKeyForDeliveryDiagnostics(params) {
    return params.mirror?.sessionKey ?? params.session?.key ?? params.session?.policyKey;
}
function deliveryKindForPayload(payload, payloadSummary) {
    if (payloadSummary.mediaUrls.length > 0 || payload.mediaUrl || payload.mediaUrls?.length) {
        return "media";
    }
    if (payload.presentation || payload.interactive || payload.channelData || payload.audioAsVoice) {
        return "other";
    }
    return "text";
}
function emitMessageDeliveryStarted(params) {
    emitDiagnosticEvent({
        type: "message.delivery.started",
        channel: params.channel,
        deliveryKind: params.deliveryKind,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
}
function emitMessageDeliveryCompleted(params) {
    emitDiagnosticEvent({
        type: "message.delivery.completed",
        channel: params.channel,
        deliveryKind: params.deliveryKind,
        durationMs: params.durationMs,
        resultCount: params.resultCount,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
}
function emitMessageDeliveryError(params) {
    emitDiagnosticEvent({
        type: "message.delivery.error",
        channel: params.channel,
        deliveryKind: params.deliveryKind,
        durationMs: params.durationMs,
        errorCategory: diagnosticErrorCategory(params.error),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
}
function normalizeEmptyPayloadForDelivery(payload) {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) {
        if (!hasReplyPayloadContent({ ...payload, text })) {
            return null;
        }
        if (text) {
            return {
                ...payload,
                text: "",
            };
        }
    }
    return payload;
}
function normalizePayloadsForChannelDelivery(plan, handler) {
    const normalizedPayloads = [];
    for (const payload of projectOutboundPayloadPlanForDelivery(plan)) {
        let sanitizedPayload = payload;
        if (handler.sanitizeText && sanitizedPayload.text) {
            if (!handler.shouldSkipPlainTextSanitization?.(sanitizedPayload)) {
                sanitizedPayload = {
                    ...sanitizedPayload,
                    text: handler.sanitizeText(sanitizedPayload),
                };
            }
        }
        const normalizedPayload = handler.normalizePayload
            ? handler.normalizePayload(sanitizedPayload)
            : sanitizedPayload;
        const normalized = normalizedPayload
            ? normalizeEmptyPayloadForDelivery(normalizedPayload)
            : null;
        if (normalized) {
            normalizedPayloads.push(normalized);
        }
    }
    return normalizedPayloads;
}
function buildPayloadSummary(payload) {
    return summarizeOutboundPayloadForTransport(payload);
}
function normalizeDeliveryPin(payload) {
    const pin = payload.delivery?.pin;
    if (pin === true) {
        return { enabled: true };
    }
    if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
        return undefined;
    }
    if (!pin.enabled) {
        return undefined;
    }
    const normalized = { enabled: true };
    if (pin.notify === true) {
        normalized.notify = true;
    }
    if (pin.required === true) {
        normalized.required = true;
    }
    return normalized;
}
async function maybePinDeliveredMessage(params) {
    const pin = normalizeDeliveryPin(params.payload);
    if (!pin) {
        return;
    }
    if (!params.messageId) {
        if (pin.required) {
            throw new Error("Delivery pin requested, but no delivered message id was returned.");
        }
        log.warn("Delivery pin requested, but no delivered message id was returned.", {
            channel: params.target.channel,
            to: params.target.to,
        });
        return;
    }
    if (!params.handler.pinDeliveredMessage) {
        if (pin.required) {
            throw new Error(`Delivery pin is not supported by channel: ${params.target.channel}`);
        }
        log.warn("Delivery pin requested, but channel does not support pinning delivered messages.", {
            channel: params.target.channel,
            to: params.target.to,
        });
        return;
    }
    try {
        await params.handler.pinDeliveredMessage({
            target: params.target,
            messageId: params.messageId,
            pin,
        });
    }
    catch (err) {
        if (pin.required) {
            throw err;
        }
        log.warn("Delivery pin requested, but channel failed to pin delivered message.", {
            channel: params.target.channel,
            to: params.target.to,
            messageId: params.messageId,
            error: formatErrorMessage(err),
        });
    }
}
async function maybeNotifyAfterDeliveredPayload(params) {
    if (!params.handler.afterDeliverPayload || params.results.length === 0) {
        return;
    }
    try {
        await params.handler.afterDeliverPayload({
            target: params.target,
            payload: params.payload,
            results: params.results,
        });
    }
    catch (err) {
        log.warn("Plugin outbound adapter after-delivery hook failed.", {
            channel: params.target.channel,
            to: params.target.to,
            error: formatErrorMessage(err),
        });
    }
}
async function renderPresentationForDelivery(handler, payload) {
    const presentation = normalizeMessagePresentation(payload.presentation);
    if (!presentation) {
        return payload;
    }
    const rendered = handler.renderPresentation ? await handler.renderPresentation(payload) : null;
    if (rendered) {
        const { presentation: _presentation, ...withoutPresentation } = rendered;
        return withoutPresentation;
    }
    const { presentation: _presentation, ...withoutPresentation } = payload;
    return {
        ...withoutPresentation,
        text: renderMessagePresentationFallbackText({
            text: payload.text,
            presentation,
        }),
    };
}
function createMessageSentEmitter(params) {
    const hasMessageSentHooks = params.hookRunner?.hasHooks("message_sent") ?? false;
    const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
    const emitMessageSent = (event) => {
        if (!hasMessageSentHooks && !canEmitInternalHook) {
            return;
        }
        const canonical = buildCanonicalSentMessageHookContext({
            to: params.to,
            content: event.content,
            success: event.success,
            error: event.error,
            channelId: params.channel,
            accountId: params.accountId ?? undefined,
            conversationId: params.to,
            messageId: event.messageId,
            isGroup: params.mirrorIsGroup,
            groupId: params.mirrorGroupId,
        });
        if (hasMessageSentHooks) {
            fireAndForgetHook(params.hookRunner.runMessageSent(toPluginMessageSentEvent(canonical), toPluginMessageContext(canonical)), "deliverOutboundPayloads: message_sent plugin hook failed", (message) => {
                log.warn(message);
            });
        }
        if (!canEmitInternalHook) {
            return;
        }
        fireAndForgetHook(triggerInternalHook(createInternalHookEvent("message", "sent", params.sessionKeyForInternalHooks, toInternalMessageSentContext(canonical))), "deliverOutboundPayloads: message:sent internal hook failed", (message) => {
            log.warn(message);
        });
    };
    return { emitMessageSent, hasMessageSentHooks };
}
async function applyMessageSendingHook(params) {
    if (!params.enabled) {
        return {
            cancelled: false,
            payload: params.payload,
            payloadSummary: params.payloadSummary,
        };
    }
    try {
        const sendingResult = await params.hookRunner.runMessageSending({
            to: params.to,
            content: params.payloadSummary.hookContent ?? params.payloadSummary.text,
            replyToId: params.replyToId ?? undefined,
            threadId: params.threadId ?? undefined,
            metadata: {
                channel: params.channel,
                accountId: params.accountId,
                mediaUrls: params.payloadSummary.mediaUrls,
            },
        }, {
            channelId: params.channel,
            accountId: params.accountId ?? undefined,
            conversationId: params.to,
        });
        if (sendingResult?.cancel) {
            return {
                cancelled: true,
                payload: params.payload,
                payloadSummary: params.payloadSummary,
            };
        }
        if (sendingResult?.content == null) {
            return {
                cancelled: false,
                payload: params.payload,
                payloadSummary: params.payloadSummary,
            };
        }
        if (params.payloadSummary.hookContent && !params.payloadSummary.text) {
            const spokenText = sendingResult.content;
            return {
                cancelled: false,
                payload: {
                    ...params.payload,
                    spokenText,
                },
                payloadSummary: {
                    ...params.payloadSummary,
                    hookContent: spokenText,
                },
            };
        }
        const payload = {
            ...params.payload,
            text: sendingResult.content,
        };
        return {
            cancelled: false,
            payload,
            payloadSummary: {
                ...params.payloadSummary,
                text: sendingResult.content,
            },
        };
    }
    catch {
        // Don't block delivery on hook failure.
        return {
            cancelled: false,
            payload: params.payload,
            payloadSummary: params.payloadSummary,
        };
    }
}
export async function deliverOutboundPayloads(params) {
    const { channel, to, payloads } = params;
    // Write-ahead delivery queue: persist before sending, remove after success.
    const queueId = params.skipQueue
        ? null
        : await enqueueDelivery({
            channel,
            to,
            accountId: params.accountId,
            payloads,
            threadId: params.threadId,
            replyToId: params.replyToId,
            replyToMode: params.replyToMode,
            formatting: params.formatting,
            bestEffort: params.bestEffort,
            gifPlayback: params.gifPlayback,
            forceDocument: params.forceDocument,
            silent: params.silent,
            mirror: params.mirror,
            session: params.session,
            gatewayClientScopes: params.gatewayClientScopes,
        }).catch(() => null); // Best-effort — don't block delivery if queue write fails.
    if (!queueId) {
        return await deliverOutboundPayloadsWithQueueCleanup(params, null);
    }
    // Hold the same in-process claim used by recovery/drain while the live send
    // owns this queue entry.
    const claimResult = await withActiveDeliveryClaim(queueId, () => deliverOutboundPayloadsWithQueueCleanup(params, queueId));
    if (claimResult.status === "claimed-by-other-owner") {
        return [];
    }
    return claimResult.value;
}
async function deliverOutboundPayloadsWithQueueCleanup(params, queueId) {
    // Wrap onError to detect partial failures under bestEffort mode.
    // When bestEffort is true, per-payload errors are caught and passed to onError
    // without throwing — so the outer try/catch never fires. We track whether any
    // payload failed so we can call failDelivery instead of ackDelivery.
    let hadPartialFailure = false;
    const wrappedParams = params.onError
        ? {
            ...params,
            onError: (err, payload) => {
                hadPartialFailure = true;
                params.onError(err, payload);
            },
        }
        : params;
    try {
        const results = await deliverOutboundPayloadsCore(wrappedParams);
        if (queueId) {
            if (hadPartialFailure) {
                await failDelivery(queueId, "partial delivery failure (bestEffort)").catch(() => { });
            }
            else {
                await ackDelivery(queueId).catch(() => { }); // Best-effort cleanup.
            }
        }
        return results;
    }
    catch (err) {
        if (queueId) {
            if (isAbortError(err)) {
                await ackDelivery(queueId).catch(() => { });
            }
            else {
                await failDelivery(queueId, formatErrorMessage(err)).catch(() => { });
            }
        }
        throw err;
    }
}
/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(params) {
    const { cfg, channel, to, payloads } = params;
    const outboundPayloadPlan = createOutboundPayloadPlan(payloads, {
        cfg,
        sessionKey: params.session?.policyKey ?? params.session?.key,
        surface: channel,
        conversationType: params.session?.conversationType,
    });
    const accountId = params.accountId;
    const deps = params.deps;
    const abortSignal = params.abortSignal;
    const mediaSources = collectPayloadMediaSources(outboundPayloadPlan);
    const mediaAccess = mediaSources.length > 0
        ? resolveAgentScopedOutboundMediaAccess({
            cfg,
            agentId: params.session?.agentId ?? params.mirror?.agentId,
            mediaSources,
            mediaAccess: params.mediaAccess,
            sessionKey: params.session?.key,
            messageProvider: params.session?.key ? undefined : channel,
            accountId: params.session?.requesterAccountId ?? accountId,
            requesterSenderId: params.session?.requesterSenderId,
            requesterSenderName: params.session?.requesterSenderName,
            requesterSenderUsername: params.session?.requesterSenderUsername,
            requesterSenderE164: params.session?.requesterSenderE164,
        })
        : (params.mediaAccess ?? {});
    const results = [];
    const handler = await createChannelHandler({
        cfg,
        channel,
        to,
        deps,
        accountId,
        replyToId: params.replyToId,
        replyToMode: params.replyToMode,
        formatting: params.formatting,
        threadId: params.threadId,
        identity: params.identity,
        gifPlayback: params.gifPlayback,
        forceDocument: params.forceDocument,
        silent: params.silent,
        mediaAccess,
        gatewayClientScopes: params.gatewayClientScopes,
    });
    const configuredTextLimit = handler.chunker
        ? resolveTextChunkLimit(cfg, channel, accountId, {
            fallbackLimit: handler.textChunkLimit,
        })
        : undefined;
    const textLimit = params.formatting?.textLimit ??
        (handler.resolveEffectiveTextChunkLimit
            ? handler.resolveEffectiveTextChunkLimit(configuredTextLimit)
            : configuredTextLimit);
    const chunkMode = handler.chunker
        ? (params.formatting?.chunkMode ?? resolveChunkMode(cfg, channel, accountId))
        : "length";
    const { resolveCurrentReplyTo, applyReplyToConsumption } = createReplyToDeliveryPolicy({
        replyToId: params.replyToId,
        replyToMode: params.replyToMode,
    });
    const sendTextChunks = async (text, overrides = {}) => {
        const units = planOutboundTextMessageUnits({
            text,
            overrides,
            chunker: handler.chunker,
            chunkerMode: handler.chunkerMode,
            textLimit,
            chunkMode,
            formatting: params.formatting,
            consumeReplyTo: (value) => applyReplyToConsumption(value, {
                consumeImplicitReply: value.replyToIdSource === "implicit",
            }),
        });
        for (const unit of units) {
            if (unit.kind !== "text") {
                continue;
            }
            throwIfAborted(abortSignal);
            results.push(await handler.sendText(unit.text, unit.overrides));
        }
    };
    const normalizedPayloads = normalizePayloadsForChannelDelivery(outboundPayloadPlan, handler);
    const hookRunner = getGlobalHookRunner();
    const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
    const mirrorIsGroup = params.mirror?.isGroup;
    const mirrorGroupId = params.mirror?.groupId;
    const { emitMessageSent, hasMessageSentHooks } = createMessageSentEmitter({
        hookRunner,
        channel,
        to,
        accountId,
        sessionKeyForInternalHooks,
        mirrorIsGroup,
        mirrorGroupId,
    });
    const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
    const diagnosticSessionKey = sessionKeyForDeliveryDiagnostics(params);
    if (hasMessageSentHooks && params.session?.agentId && !sessionKeyForInternalHooks) {
        log.warn("deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped", {
            channel,
            to,
            agentId: params.session.agentId,
        });
    }
    for (const payload of normalizedPayloads) {
        let payloadSummary = buildPayloadSummary(payload);
        let deliveryKind = "other";
        let deliveryStartedAt = 0;
        let deliveryStarted = false;
        let deliveryFinished = false;
        const startDeliveryDiagnostics = (kind) => {
            deliveryKind = kind;
            deliveryStartedAt = Date.now();
            deliveryStarted = true;
            deliveryFinished = false;
            emitMessageDeliveryStarted({
                channel,
                deliveryKind,
                sessionKey: diagnosticSessionKey,
            });
        };
        const completeDeliveryDiagnostics = (resultCount) => {
            if (!deliveryStarted) {
                return;
            }
            deliveryFinished = true;
            emitMessageDeliveryCompleted({
                channel,
                deliveryKind,
                durationMs: Date.now() - deliveryStartedAt,
                resultCount,
                sessionKey: diagnosticSessionKey,
            });
        };
        const errorDeliveryDiagnostics = (err) => {
            if (!deliveryStarted || deliveryFinished) {
                return;
            }
            deliveryFinished = true;
            emitMessageDeliveryError({
                channel,
                deliveryKind,
                durationMs: Date.now() - deliveryStartedAt,
                error: err,
                sessionKey: diagnosticSessionKey,
            });
        };
        try {
            throwIfAborted(abortSignal);
            // Run message_sending plugin hook (may modify content or cancel)
            const hookResult = await applyMessageSendingHook({
                hookRunner,
                enabled: hasMessageSendingHooks,
                payload,
                payloadSummary,
                to,
                channel,
                accountId,
                replyToId: resolveCurrentReplyTo(payload).replyToId,
                threadId: params.threadId,
            });
            if (hookResult.cancelled) {
                continue;
            }
            const renderedPayload = await renderPresentationForDelivery(handler, hookResult.payload);
            const normalizedEffectivePayload = handler.normalizePayload
                ? handler.normalizePayload(renderedPayload)
                : renderedPayload;
            const effectivePayload = normalizedEffectivePayload
                ? normalizeEmptyPayloadForDelivery(normalizedEffectivePayload)
                : null;
            if (!effectivePayload) {
                continue;
            }
            payloadSummary = buildPayloadSummary(effectivePayload);
            startDeliveryDiagnostics(deliveryKindForPayload(effectivePayload, payloadSummary));
            params.onPayload?.(payloadSummary);
            const replyToResolution = resolveCurrentReplyTo(effectivePayload);
            const sendOverrides = {
                replyToId: replyToResolution.replyToId,
                replyToIdSource: replyToResolution.source,
                ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
                ...(effectivePayload.audioAsVoice === true ? { audioAsVoice: true } : {}),
                ...(params.forceDocument !== undefined ? { forceDocument: params.forceDocument } : {}),
            };
            const applySendReplyToConsumption = (overrides) => applyReplyToConsumption(overrides, {
                consumeImplicitReply: replyToResolution.source === "implicit",
            });
            const deliveryTarget = handler.buildTargetRef({ threadId: sendOverrides.threadId });
            if (handler.sendPayload &&
                (hasReplyPayloadContent({
                    presentation: effectivePayload.presentation,
                    interactive: effectivePayload.interactive,
                    channelData: effectivePayload.channelData,
                }) ||
                    effectivePayload.audioAsVoice === true)) {
                const delivery = await handler.sendPayload(effectivePayload, applySendReplyToConsumption(sendOverrides));
                results.push(delivery);
                await maybePinDeliveredMessage({
                    handler,
                    payload: effectivePayload,
                    target: deliveryTarget,
                    messageId: delivery.messageId,
                });
                await maybeNotifyAfterDeliveredPayload({
                    handler,
                    payload: effectivePayload,
                    target: deliveryTarget,
                    results: [delivery],
                });
                completeDeliveryDiagnostics(1);
                emitMessageSent({
                    success: true,
                    content: payloadSummary.hookContent ?? payloadSummary.text,
                    messageId: delivery.messageId,
                });
                continue;
            }
            if (payloadSummary.mediaUrls.length === 0) {
                const beforeCount = results.length;
                if (handler.sendFormattedText) {
                    results.push(...(await handler.sendFormattedText(payloadSummary.text, applySendReplyToConsumption(sendOverrides))));
                }
                else {
                    await sendTextChunks(payloadSummary.text, sendOverrides);
                }
                const deliveredResults = results.slice(beforeCount);
                const messageId = results.at(-1)?.messageId;
                const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
                await maybePinDeliveredMessage({
                    handler,
                    payload: effectivePayload,
                    target: deliveryTarget,
                    messageId: pinMessageId,
                });
                await maybeNotifyAfterDeliveredPayload({
                    handler,
                    payload: effectivePayload,
                    target: deliveryTarget,
                    results: deliveredResults,
                });
                completeDeliveryDiagnostics(deliveredResults.length);
                emitMessageSent({
                    success: results.length > beforeCount,
                    content: payloadSummary.hookContent ?? payloadSummary.text,
                    messageId,
                });
                continue;
            }
            if (!handler.supportsMedia) {
                log.warn("Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used", {
                    channel,
                    to,
                    mediaCount: payloadSummary.mediaUrls.length,
                });
                const fallbackText = payloadSummary.text.trim();
                if (!fallbackText) {
                    throw new Error("Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload");
                }
                const beforeCount = results.length;
                await sendTextChunks(fallbackText, sendOverrides);
                const deliveredResults = results.slice(beforeCount);
                const messageId = results.at(-1)?.messageId;
                const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
                await maybePinDeliveredMessage({
                    handler,
                    payload: effectivePayload,
                    target: deliveryTarget,
                    messageId: pinMessageId,
                });
                await maybeNotifyAfterDeliveredPayload({
                    handler,
                    payload: effectivePayload,
                    target: deliveryTarget,
                    results: deliveredResults,
                });
                completeDeliveryDiagnostics(deliveredResults.length);
                emitMessageSent({
                    success: results.length > beforeCount,
                    content: payloadSummary.hookContent ?? payloadSummary.text,
                    messageId,
                });
                continue;
            }
            let firstMessageId;
            let lastMessageId;
            const beforeCount = results.length;
            const mediaUnits = planOutboundMediaMessageUnits({
                mediaUrls: payloadSummary.mediaUrls,
                caption: payloadSummary.text,
                overrides: sendOverrides,
                consumeReplyTo: applySendReplyToConsumption,
            });
            for (const unit of mediaUnits) {
                if (unit.kind !== "media") {
                    continue;
                }
                throwIfAborted(abortSignal);
                const delivery = handler.sendFormattedMedia
                    ? await handler.sendFormattedMedia(unit.caption ?? "", unit.mediaUrl, unit.overrides)
                    : await handler.sendMedia(unit.caption ?? "", unit.mediaUrl, unit.overrides);
                results.push(delivery);
                firstMessageId ??= delivery.messageId;
                lastMessageId = delivery.messageId;
            }
            await maybePinDeliveredMessage({
                handler,
                payload: effectivePayload,
                target: deliveryTarget,
                messageId: firstMessageId,
            });
            await maybeNotifyAfterDeliveredPayload({
                handler,
                payload: effectivePayload,
                target: deliveryTarget,
                results: results.slice(beforeCount),
            });
            completeDeliveryDiagnostics(results.length - beforeCount);
            emitMessageSent({
                success: true,
                content: payloadSummary.hookContent ?? payloadSummary.text,
                messageId: lastMessageId,
            });
        }
        catch (err) {
            errorDeliveryDiagnostics(err);
            emitMessageSent({
                success: false,
                content: payloadSummary.hookContent ?? payloadSummary.text,
                error: formatErrorMessage(err),
            });
            if (!params.bestEffort) {
                throw err;
            }
            params.onError?.(err, payloadSummary);
        }
    }
    if (params.mirror && results.length > 0) {
        const mirrorText = resolveMirroredTranscriptText({
            text: params.mirror.text,
            mediaUrls: params.mirror.mediaUrls,
        });
        if (mirrorText) {
            const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
            await appendAssistantMessageToSessionTranscript({
                agentId: params.mirror.agentId,
                sessionKey: params.mirror.sessionKey,
                text: mirrorText,
                idempotencyKey: params.mirror.idempotencyKey,
            });
        }
    }
    return results;
}
