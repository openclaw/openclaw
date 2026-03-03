import { chunkByParagraph, chunkMarkdownTextWithMode, resolveChunkMode, resolveTextChunkLimit, } from "../../auto-reply/chunk.js";
import { resolveChannelMediaMaxBytes } from "../../channels/plugins/media-limits.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { appendAssistantMessageToSessionTranscript, resolveMirroredTranscriptText, } from "../../config/sessions.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { markdownToSignalTextChunks } from "../../signal/format.js";
import { sendMessageSignal } from "../../signal/send.js";
import { throwIfAborted } from "./abort.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "./delivery-queue.js";
import { normalizeReplyPayloadsForDelivery } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";
const log = createSubsystemLogger("outbound/deliver");
const TELEGRAM_TEXT_LIMIT = 4096;
// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function createChannelHandler(params) {
    const outbound = await loadChannelOutboundAdapter(params.channel);
    const handler = createPluginHandler({ ...params, outbound });
    if (!handler) {
        throw new Error(`Outbound not configured for channel: ${params.channel}`);
    }
    return handler;
}
function createPluginHandler(params) {
    const outbound = params.outbound;
    if (!outbound?.sendText || !outbound?.sendMedia) {
        return null;
    }
    const baseCtx = createChannelOutboundContextBase(params);
    const sendText = outbound.sendText;
    const sendMedia = outbound.sendMedia;
    const chunker = outbound.chunker ?? null;
    const chunkerMode = outbound.chunkerMode;
    const resolveCtx = (overrides) => ({
        ...baseCtx,
        replyToId: overrides?.replyToId ?? baseCtx.replyToId,
        threadId: overrides?.threadId ?? baseCtx.threadId,
    });
    return {
        chunker,
        chunkerMode,
        textChunkLimit: outbound.textChunkLimit,
        sendPayload: outbound.sendPayload
            ? async (payload, overrides) => outbound.sendPayload({
                ...resolveCtx(overrides),
                text: payload.text ?? "",
                mediaUrl: payload.mediaUrl,
                payload,
            })
            : undefined,
        sendText: async (text, overrides) => sendText({
            ...resolveCtx(overrides),
            text,
        }),
        sendMedia: async (caption, mediaUrl, overrides) => sendMedia({
            ...resolveCtx(overrides),
            text: caption,
            mediaUrl,
        }),
    };
}
function createChannelOutboundContextBase(params) {
    return {
        cfg: params.cfg,
        to: params.to,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        identity: params.identity,
        gifPlayback: params.gifPlayback,
        deps: params.deps,
        silent: params.silent,
        mediaLocalRoots: params.mediaLocalRoots,
    };
}
const isAbortError = (err) => err instanceof Error && err.name === "AbortError";
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
            bestEffort: params.bestEffort,
            gifPlayback: params.gifPlayback,
            silent: params.silent,
            mirror: params.mirror,
        }).catch(() => null); // Best-effort — don't block delivery if queue write fails.
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
                await failDelivery(queueId, err instanceof Error ? err.message : String(err)).catch(() => { });
            }
        }
        throw err;
    }
}
/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(params) {
    const { cfg, channel, to, payloads } = params;
    const accountId = params.accountId;
    const deps = params.deps;
    const abortSignal = params.abortSignal;
    const sendSignal = params.deps?.sendSignal ?? sendMessageSignal;
    const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, params.session?.agentId ?? params.mirror?.agentId);
    const results = [];
    const handler = await createChannelHandler({
        cfg,
        channel,
        to,
        deps,
        accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        identity: params.identity,
        gifPlayback: params.gifPlayback,
        silent: params.silent,
        mediaLocalRoots,
    });
    const configuredTextLimit = handler.chunker
        ? resolveTextChunkLimit(cfg, channel, accountId, {
            fallbackLimit: handler.textChunkLimit,
        })
        : undefined;
    const textLimit = channel === "telegram" && typeof configuredTextLimit === "number"
        ? Math.min(configuredTextLimit, TELEGRAM_TEXT_LIMIT)
        : configuredTextLimit;
    const chunkMode = handler.chunker ? resolveChunkMode(cfg, channel, accountId) : "length";
    const isSignalChannel = channel === "signal";
    const signalTableMode = isSignalChannel
        ? resolveMarkdownTableMode({ cfg, channel: "signal", accountId })
        : "code";
    const signalMaxBytes = isSignalChannel
        ? resolveChannelMediaMaxBytes({
            cfg,
            resolveChannelLimitMb: ({ cfg, accountId }) => cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
                cfg.channels?.signal?.mediaMaxMb,
            accountId,
        })
        : undefined;
    const sendTextChunks = async (text, overrides) => {
        throwIfAborted(abortSignal);
        if (!handler.chunker || textLimit === undefined) {
            results.push(await handler.sendText(text, overrides));
            return;
        }
        if (chunkMode === "newline") {
            const mode = handler.chunkerMode ?? "text";
            const blockChunks = mode === "markdown"
                ? chunkMarkdownTextWithMode(text, textLimit, "newline")
                : chunkByParagraph(text, textLimit);
            if (!blockChunks.length && text) {
                blockChunks.push(text);
            }
            for (const blockChunk of blockChunks) {
                const chunks = handler.chunker(blockChunk, textLimit);
                if (!chunks.length && blockChunk) {
                    chunks.push(blockChunk);
                }
                for (const chunk of chunks) {
                    throwIfAborted(abortSignal);
                    results.push(await handler.sendText(chunk, overrides));
                }
            }
            return;
        }
        const chunks = handler.chunker(text, textLimit);
        for (const chunk of chunks) {
            throwIfAborted(abortSignal);
            results.push(await handler.sendText(chunk, overrides));
        }
    };
    const sendSignalText = async (text, styles) => {
        throwIfAborted(abortSignal);
        return {
            channel: "signal",
            ...(await sendSignal(to, text, {
                maxBytes: signalMaxBytes,
                accountId: accountId ?? undefined,
                textMode: "plain",
                textStyles: styles,
            })),
        };
    };
    const sendSignalTextChunks = async (text) => {
        throwIfAborted(abortSignal);
        let signalChunks = textLimit === undefined
            ? markdownToSignalTextChunks(text, Number.POSITIVE_INFINITY, {
                tableMode: signalTableMode,
            })
            : markdownToSignalTextChunks(text, textLimit, { tableMode: signalTableMode });
        if (signalChunks.length === 0 && text) {
            signalChunks = [{ text, styles: [] }];
        }
        for (const chunk of signalChunks) {
            throwIfAborted(abortSignal);
            results.push(await sendSignalText(chunk.text, chunk.styles));
        }
    };
    const sendSignalMedia = async (caption, mediaUrl) => {
        throwIfAborted(abortSignal);
        const formatted = markdownToSignalTextChunks(caption, Number.POSITIVE_INFINITY, {
            tableMode: signalTableMode,
        })[0] ?? {
            text: caption,
            styles: [],
        };
        return {
            channel: "signal",
            ...(await sendSignal(to, formatted.text, {
                mediaUrl,
                maxBytes: signalMaxBytes,
                accountId: accountId ?? undefined,
                textMode: "plain",
                textStyles: formatted.styles,
                mediaLocalRoots,
            })),
        };
    };
    const normalizeWhatsAppPayload = (payload) => {
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        const rawText = typeof payload.text === "string" ? payload.text : "";
        const normalizedText = rawText.replace(/^(?:[ \t]*\r?\n)+/, "");
        if (!normalizedText.trim()) {
            if (!hasMedia) {
                return null;
            }
            return {
                ...payload,
                text: "",
            };
        }
        return {
            ...payload,
            text: normalizedText,
        };
    };
    const normalizedPayloads = normalizeReplyPayloadsForDelivery(payloads).flatMap((payload) => {
        if (channel !== "whatsapp") {
            return [payload];
        }
        const normalized = normalizeWhatsAppPayload(payload);
        return normalized ? [normalized] : [];
    });
    const hookRunner = getGlobalHookRunner();
    const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
    if (hookRunner?.hasHooks("message_sent") &&
        params.session?.agentId &&
        !sessionKeyForInternalHooks) {
        log.warn("deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped", {
            channel,
            to,
            agentId: params.session.agentId,
        });
    }
    for (const payload of normalizedPayloads) {
        const payloadSummary = {
            text: payload.text ?? "",
            mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
            channelData: payload.channelData,
        };
        const emitMessageSent = (params) => {
            if (hookRunner?.hasHooks("message_sent")) {
                void hookRunner
                    .runMessageSent({
                    to,
                    content: params.content,
                    success: params.success,
                    ...(params.error ? { error: params.error } : {}),
                }, {
                    channelId: channel,
                    accountId: accountId ?? undefined,
                    conversationId: to,
                })
                    .catch(() => { });
            }
            if (!sessionKeyForInternalHooks) {
                return;
            }
            void triggerInternalHook(createInternalHookEvent("message", "sent", sessionKeyForInternalHooks, {
                to,
                content: params.content,
                success: params.success,
                ...(params.error ? { error: params.error } : {}),
                channelId: channel,
                accountId: accountId ?? undefined,
                conversationId: to,
                messageId: params.messageId,
            })).catch(() => { });
        };
        try {
            throwIfAborted(abortSignal);
            // Run message_sending plugin hook (may modify content or cancel)
            let effectivePayload = payload;
            if (hookRunner?.hasHooks("message_sending")) {
                try {
                    const sendingResult = await hookRunner.runMessageSending({
                        to,
                        content: payloadSummary.text,
                        metadata: { channel, accountId, mediaUrls: payloadSummary.mediaUrls },
                    }, {
                        channelId: channel,
                        accountId: accountId ?? undefined,
                    });
                    if (sendingResult?.cancel) {
                        continue;
                    }
                    if (sendingResult?.content != null) {
                        effectivePayload = { ...payload, text: sendingResult.content };
                        payloadSummary.text = sendingResult.content;
                    }
                }
                catch {
                    // Don't block delivery on hook failure
                }
            }
            params.onPayload?.(payloadSummary);
            const sendOverrides = {
                replyToId: effectivePayload.replyToId ?? params.replyToId ?? undefined,
                threadId: params.threadId ?? undefined,
            };
            if (handler.sendPayload && effectivePayload.channelData) {
                const delivery = await handler.sendPayload(effectivePayload, sendOverrides);
                results.push(delivery);
                emitMessageSent({
                    success: true,
                    content: payloadSummary.text,
                    messageId: delivery.messageId,
                });
                continue;
            }
            if (payloadSummary.mediaUrls.length === 0) {
                const beforeCount = results.length;
                if (isSignalChannel) {
                    await sendSignalTextChunks(payloadSummary.text);
                }
                else {
                    await sendTextChunks(payloadSummary.text, sendOverrides);
                }
                const messageId = results.at(-1)?.messageId;
                emitMessageSent({
                    success: results.length > beforeCount,
                    content: payloadSummary.text,
                    messageId,
                });
                continue;
            }
            let first = true;
            let lastMessageId;
            for (const url of payloadSummary.mediaUrls) {
                throwIfAborted(abortSignal);
                const caption = first ? payloadSummary.text : "";
                first = false;
                if (isSignalChannel) {
                    const delivery = await sendSignalMedia(caption, url);
                    results.push(delivery);
                    lastMessageId = delivery.messageId;
                }
                else {
                    const delivery = await handler.sendMedia(caption, url, sendOverrides);
                    results.push(delivery);
                    lastMessageId = delivery.messageId;
                }
            }
            emitMessageSent({
                success: true,
                content: payloadSummary.text,
                messageId: lastMessageId,
            });
        }
        catch (err) {
            emitMessageSent({
                success: false,
                content: payloadSummary.text,
                error: err instanceof Error ? err.message : String(err),
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
            await appendAssistantMessageToSessionTranscript({
                agentId: params.mirror.agentId,
                sessionKey: params.mirror.sessionKey,
                text: mirrorText,
            });
        }
    }
    return results;
}
