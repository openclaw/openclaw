import { GrammyError, InputFile } from "grammy";
import { chunkMarkdownTextWithMode } from "../../auto-reply/chunk.js";
import { danger, logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { buildOutboundMediaLoadOptions } from "../../media/load-options.js";
import { isGifMedia } from "../../media/mime.js";
import { loadWebMedia } from "../../web/media.js";
import { splitTelegramCaption } from "../caption.js";
import { markdownToTelegramChunks, markdownToTelegramHtml, renderTelegramHtmlText, wrapFileReferencesInHtml, } from "../format.js";
import { buildInlineKeyboard } from "../send.js";
import { resolveTelegramVoiceSend } from "../voice.js";
import { buildTelegramSendParams, sendTelegramText, sendTelegramWithThreadFallback, } from "./delivery.send.js";
import { resolveTelegramReplyId } from "./helpers.js";
const VOICE_FORBIDDEN_RE = /VOICE_MESSAGES_FORBIDDEN/;
const CAPTION_TOO_LONG_RE = /caption is too long/i;
function buildChunkTextResolver(params) {
    return (markdown) => {
        const markdownChunks = params.chunkMode === "newline"
            ? chunkMarkdownTextWithMode(markdown, params.textLimit, params.chunkMode)
            : [markdown];
        const chunks = [];
        for (const chunk of markdownChunks) {
            const nested = markdownToTelegramChunks(chunk, params.textLimit, {
                tableMode: params.tableMode,
            });
            if (!nested.length && chunk) {
                chunks.push({
                    html: wrapFileReferencesInHtml(markdownToTelegramHtml(chunk, { tableMode: params.tableMode, wrapFileRefs: false })),
                    text: chunk,
                });
                continue;
            }
            chunks.push(...nested);
        }
        return chunks;
    };
}
function resolveReplyToForSend(params) {
    return params.replyToId && (params.replyToMode === "all" || !params.progress.hasReplied)
        ? params.replyToId
        : undefined;
}
function markReplyApplied(progress, replyToId) {
    if (replyToId && !progress.hasReplied) {
        progress.hasReplied = true;
    }
}
function markDelivered(progress) {
    progress.hasDelivered = true;
}
async function deliverTextReply(params) {
    const chunks = params.chunkText(params.replyText);
    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (!chunk) {
            continue;
        }
        const shouldAttachButtons = i === 0 && params.replyMarkup;
        const replyToForChunk = resolveReplyToForSend({
            replyToId: params.replyToId,
            replyToMode: params.replyToMode,
            progress: params.progress,
        });
        await sendTelegramText(params.bot, params.chatId, chunk.html, params.runtime, {
            replyToMessageId: replyToForChunk,
            replyQuoteText: params.replyQuoteText,
            thread: params.thread,
            textMode: "html",
            plainText: chunk.text,
            linkPreview: params.linkPreview,
            replyMarkup: shouldAttachButtons ? params.replyMarkup : undefined,
        });
        markReplyApplied(params.progress, replyToForChunk);
        markDelivered(params.progress);
    }
}
async function sendPendingFollowUpText(params) {
    const chunks = params.chunkText(params.text);
    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const replyToForFollowUp = resolveReplyToForSend({
            replyToId: params.replyToId,
            replyToMode: params.replyToMode,
            progress: params.progress,
        });
        await sendTelegramText(params.bot, params.chatId, chunk.html, params.runtime, {
            replyToMessageId: replyToForFollowUp,
            thread: params.thread,
            textMode: "html",
            plainText: chunk.text,
            linkPreview: params.linkPreview,
            replyMarkup: i === 0 ? params.replyMarkup : undefined,
        });
        markReplyApplied(params.progress, replyToForFollowUp);
        markDelivered(params.progress);
    }
}
function isVoiceMessagesForbidden(err) {
    if (err instanceof GrammyError) {
        return VOICE_FORBIDDEN_RE.test(err.description);
    }
    return VOICE_FORBIDDEN_RE.test(formatErrorMessage(err));
}
function isCaptionTooLong(err) {
    if (err instanceof GrammyError) {
        return CAPTION_TOO_LONG_RE.test(err.description);
    }
    return CAPTION_TOO_LONG_RE.test(formatErrorMessage(err));
}
async function sendTelegramVoiceFallbackText(opts) {
    const chunks = opts.chunkText(opts.text);
    let appliedReplyTo = false;
    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        // Only apply reply reference, quote text, and buttons to the first chunk.
        const replyToForChunk = !appliedReplyTo ? opts.replyToId : undefined;
        await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
            replyToMessageId: replyToForChunk,
            replyQuoteText: !appliedReplyTo ? opts.replyQuoteText : undefined,
            thread: opts.thread,
            textMode: "html",
            plainText: chunk.text,
            linkPreview: opts.linkPreview,
            replyMarkup: !appliedReplyTo ? opts.replyMarkup : undefined,
        });
        if (replyToForChunk) {
            appliedReplyTo = true;
        }
    }
}
async function deliverMediaReply(params) {
    let first = true;
    let pendingFollowUpText;
    for (const mediaUrl of params.mediaList) {
        const isFirstMedia = first;
        const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({ mediaLocalRoots: params.mediaLocalRoots }));
        const kind = mediaKindFromMime(media.contentType ?? undefined);
        const isGif = isGifMedia({
            contentType: media.contentType,
            fileName: media.fileName,
        });
        const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
        const file = new InputFile(media.buffer, fileName);
        const { caption, followUpText } = splitTelegramCaption(isFirstMedia ? (params.reply.text ?? undefined) : undefined);
        const htmlCaption = caption
            ? renderTelegramHtmlText(caption, { tableMode: params.tableMode })
            : undefined;
        if (followUpText) {
            pendingFollowUpText = followUpText;
        }
        first = false;
        const replyToMessageId = resolveReplyToForSend({
            replyToId: params.replyToId,
            replyToMode: params.replyToMode,
            progress: params.progress,
        });
        const shouldAttachButtonsToMedia = isFirstMedia && params.replyMarkup && !followUpText;
        const mediaParams = {
            caption: htmlCaption,
            ...(htmlCaption ? { parse_mode: "HTML" } : {}),
            ...(shouldAttachButtonsToMedia ? { reply_markup: params.replyMarkup } : {}),
            ...buildTelegramSendParams({
                replyToMessageId,
                thread: params.thread,
            }),
        };
        if (isGif) {
            await sendTelegramWithThreadFallback({
                operation: "sendAnimation",
                runtime: params.runtime,
                thread: params.thread,
                requestParams: mediaParams,
                send: (effectiveParams) => params.bot.api.sendAnimation(params.chatId, file, { ...effectiveParams }),
            });
            markDelivered(params.progress);
        }
        else if (kind === "image") {
            await sendTelegramWithThreadFallback({
                operation: "sendPhoto",
                runtime: params.runtime,
                thread: params.thread,
                requestParams: mediaParams,
                send: (effectiveParams) => params.bot.api.sendPhoto(params.chatId, file, { ...effectiveParams }),
            });
            markDelivered(params.progress);
        }
        else if (kind === "video") {
            await sendTelegramWithThreadFallback({
                operation: "sendVideo",
                runtime: params.runtime,
                thread: params.thread,
                requestParams: mediaParams,
                send: (effectiveParams) => params.bot.api.sendVideo(params.chatId, file, { ...effectiveParams }),
            });
            markDelivered(params.progress);
        }
        else if (kind === "audio") {
            const { useVoice } = resolveTelegramVoiceSend({
                wantsVoice: params.reply.audioAsVoice === true,
                contentType: media.contentType,
                fileName,
                logFallback: logVerbose,
            });
            if (useVoice) {
                await params.onVoiceRecording?.();
                try {
                    await sendTelegramWithThreadFallback({
                        operation: "sendVoice",
                        runtime: params.runtime,
                        thread: params.thread,
                        requestParams: mediaParams,
                        shouldLog: (err) => !isVoiceMessagesForbidden(err),
                        send: (effectiveParams) => params.bot.api.sendVoice(params.chatId, file, { ...effectiveParams }),
                    });
                    markDelivered(params.progress);
                }
                catch (voiceErr) {
                    if (isVoiceMessagesForbidden(voiceErr)) {
                        const fallbackText = params.reply.text;
                        if (!fallbackText || !fallbackText.trim()) {
                            throw voiceErr;
                        }
                        logVerbose("telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text");
                        const voiceFallbackReplyTo = resolveReplyToForSend({
                            replyToId: params.replyToId,
                            replyToMode: params.replyToMode,
                            progress: params.progress,
                        });
                        await sendTelegramVoiceFallbackText({
                            bot: params.bot,
                            chatId: params.chatId,
                            runtime: params.runtime,
                            text: fallbackText,
                            chunkText: params.chunkText,
                            replyToId: voiceFallbackReplyTo,
                            thread: params.thread,
                            linkPreview: params.linkPreview,
                            replyMarkup: params.replyMarkup,
                            replyQuoteText: params.replyQuoteText,
                        });
                        markReplyApplied(params.progress, voiceFallbackReplyTo);
                        markDelivered(params.progress);
                        continue;
                    }
                    if (isCaptionTooLong(voiceErr)) {
                        logVerbose("telegram sendVoice caption too long; resending voice without caption + text separately");
                        const noCaptionParams = { ...mediaParams };
                        delete noCaptionParams.caption;
                        delete noCaptionParams.parse_mode;
                        await sendTelegramWithThreadFallback({
                            operation: "sendVoice",
                            runtime: params.runtime,
                            thread: params.thread,
                            requestParams: noCaptionParams,
                            send: (effectiveParams) => params.bot.api.sendVoice(params.chatId, file, { ...effectiveParams }),
                        });
                        markDelivered(params.progress);
                        const fallbackText = params.reply.text;
                        if (fallbackText?.trim()) {
                            await sendTelegramVoiceFallbackText({
                                bot: params.bot,
                                chatId: params.chatId,
                                runtime: params.runtime,
                                text: fallbackText,
                                chunkText: params.chunkText,
                                replyToId: undefined,
                                thread: params.thread,
                                linkPreview: params.linkPreview,
                                replyMarkup: params.replyMarkup,
                            });
                        }
                        markReplyApplied(params.progress, replyToMessageId);
                        continue;
                    }
                    throw voiceErr;
                }
            }
            else {
                await sendTelegramWithThreadFallback({
                    operation: "sendAudio",
                    runtime: params.runtime,
                    thread: params.thread,
                    requestParams: mediaParams,
                    send: (effectiveParams) => params.bot.api.sendAudio(params.chatId, file, { ...effectiveParams }),
                });
                markDelivered(params.progress);
            }
        }
        else {
            await sendTelegramWithThreadFallback({
                operation: "sendDocument",
                runtime: params.runtime,
                thread: params.thread,
                requestParams: mediaParams,
                send: (effectiveParams) => params.bot.api.sendDocument(params.chatId, file, { ...effectiveParams }),
            });
            markDelivered(params.progress);
        }
        markReplyApplied(params.progress, replyToMessageId);
        if (pendingFollowUpText && isFirstMedia) {
            await sendPendingFollowUpText({
                bot: params.bot,
                chatId: params.chatId,
                runtime: params.runtime,
                thread: params.thread,
                chunkText: params.chunkText,
                text: pendingFollowUpText,
                replyMarkup: params.replyMarkup,
                linkPreview: params.linkPreview,
                replyToId: params.replyToId,
                replyToMode: params.replyToMode,
                progress: params.progress,
            });
            pendingFollowUpText = undefined;
        }
    }
}
export async function deliverReplies(params) {
    const progress = {
        hasReplied: false,
        hasDelivered: false,
    };
    const chunkText = buildChunkTextResolver({
        textLimit: params.textLimit,
        chunkMode: params.chunkMode ?? "length",
        tableMode: params.tableMode,
    });
    for (const reply of params.replies) {
        const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
        if (!reply?.text && !hasMedia) {
            if (reply?.audioAsVoice) {
                logVerbose("telegram reply has audioAsVoice without media/text; skipping");
                continue;
            }
            params.runtime.error?.(danger("reply missing text/media"));
            continue;
        }
        const replyToId = params.replyToMode === "off" ? undefined : resolveTelegramReplyId(reply.replyToId);
        const mediaList = reply.mediaUrls?.length
            ? reply.mediaUrls
            : reply.mediaUrl
                ? [reply.mediaUrl]
                : [];
        const telegramData = reply.channelData?.telegram;
        const replyMarkup = buildInlineKeyboard(telegramData?.buttons);
        if (mediaList.length === 0) {
            await deliverTextReply({
                bot: params.bot,
                chatId: params.chatId,
                runtime: params.runtime,
                thread: params.thread,
                chunkText,
                replyText: reply.text || "",
                replyMarkup,
                replyQuoteText: params.replyQuoteText,
                linkPreview: params.linkPreview,
                replyToId,
                replyToMode: params.replyToMode,
                progress,
            });
            continue;
        }
        await deliverMediaReply({
            reply,
            mediaList,
            bot: params.bot,
            chatId: params.chatId,
            runtime: params.runtime,
            thread: params.thread,
            tableMode: params.tableMode,
            mediaLocalRoots: params.mediaLocalRoots,
            chunkText,
            onVoiceRecording: params.onVoiceRecording,
            linkPreview: params.linkPreview,
            replyQuoteText: params.replyQuoteText,
            replyMarkup,
            replyToId,
            replyToMode: params.replyToMode,
            progress,
        });
    }
    return { delivered: progress.hasDelivered };
}
