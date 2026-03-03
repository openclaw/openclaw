import { Bot, HttpError, InputFile } from "grammy";
import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { logVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import { formatErrorMessage, formatUncaughtError } from "../infra/errors.js";
import { createTelegramRetryRunner } from "../infra/retry-policy.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mediaKindFromMime } from "../media/constants.js";
import { buildOutboundMediaLoadOptions } from "../media/load-options.js";
import { isGifMedia } from "../media/mime.js";
import { normalizePollInput } from "../polls.js";
import { loadWebMedia } from "../web/media.js";
import { resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";
import { splitTelegramCaption } from "./caption.js";
import { resolveTelegramFetch } from "./fetch.js";
import { renderTelegramHtmlText } from "./format.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { maybePersistResolvedTelegramTarget } from "./target-writeback.js";
import { normalizeTelegramChatId, normalizeTelegramLookupTarget, parseTelegramTarget, } from "./targets.js";
import { resolveTelegramVoiceSend } from "./voice.js";
function resolveTelegramMessageIdOrThrow(result, context) {
    if (typeof result?.message_id === "number" && Number.isFinite(result.message_id)) {
        return Math.trunc(result.message_id);
    }
    throw new Error(`Telegram ${context} returned no message_id`);
}
const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const MESSAGE_NOT_MODIFIED_RE = /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const CHAT_NOT_FOUND_RE = /400: Bad Request: chat not found/i;
const sendLogger = createSubsystemLogger("telegram/send");
const diagLogger = createSubsystemLogger("telegram/diagnostic");
function createTelegramHttpLogger(cfg) {
    const enabled = isDiagnosticFlagEnabled("telegram.http", cfg);
    if (!enabled) {
        return () => { };
    }
    return (label, err) => {
        if (!(err instanceof HttpError)) {
            return;
        }
        const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
        diagLogger.warn(`telegram http error (${label}): ${detail}`);
    };
}
function resolveTelegramClientOptions(account) {
    const proxyUrl = account.config.proxy?.trim();
    const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
    const fetchImpl = resolveTelegramFetch(proxyFetch, {
        network: account.config.network,
    });
    const timeoutSeconds = typeof account.config.timeoutSeconds === "number" &&
        Number.isFinite(account.config.timeoutSeconds)
        ? Math.max(1, Math.floor(account.config.timeoutSeconds))
        : undefined;
    return fetchImpl || timeoutSeconds
        ? {
            ...(fetchImpl ? { fetch: fetchImpl } : {}),
            ...(timeoutSeconds ? { timeoutSeconds } : {}),
        }
        : undefined;
}
function resolveToken(explicit, params) {
    if (explicit?.trim()) {
        return explicit.trim();
    }
    if (!params.token) {
        throw new Error(`Telegram bot token missing for account "${params.accountId}" (set channels.telegram.accounts.${params.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`);
    }
    return params.token.trim();
}
async function resolveChatId(to, params) {
    const numericChatId = normalizeTelegramChatId(to);
    if (numericChatId) {
        return numericChatId;
    }
    const lookupTarget = normalizeTelegramLookupTarget(to);
    const getChat = params.api.getChat;
    if (!lookupTarget || typeof getChat !== "function") {
        throw new Error("Telegram recipient must be a numeric chat ID");
    }
    try {
        const chat = await getChat.call(params.api, lookupTarget);
        const resolved = normalizeTelegramChatId(String(chat?.id ?? ""));
        if (!resolved) {
            throw new Error(`resolved chat id is not numeric (${String(chat?.id ?? "")})`);
        }
        if (params.verbose) {
            sendLogger.warn(`telegram recipient ${lookupTarget} resolved to numeric chat id ${resolved}`);
        }
        return resolved;
    }
    catch (err) {
        const detail = formatErrorMessage(err);
        throw new Error(`Telegram recipient ${lookupTarget} could not be resolved to a numeric chat ID (${detail})`, { cause: err });
    }
}
async function resolveAndPersistChatId(params) {
    const chatId = await resolveChatId(params.lookupTarget, {
        api: params.api,
        verbose: params.verbose,
    });
    await maybePersistResolvedTelegramTarget({
        cfg: params.cfg,
        rawTarget: params.persistTarget,
        resolvedChatId: chatId,
        verbose: params.verbose,
    });
    return chatId;
}
function normalizeMessageId(raw) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return Math.trunc(raw);
    }
    if (typeof raw === "string") {
        const value = raw.trim();
        if (!value) {
            throw new Error("Message id is required for Telegram actions");
        }
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    throw new Error("Message id is required for Telegram actions");
}
function isTelegramThreadNotFoundError(err) {
    return THREAD_NOT_FOUND_RE.test(formatErrorMessage(err));
}
function isTelegramMessageNotModifiedError(err) {
    return MESSAGE_NOT_MODIFIED_RE.test(formatErrorMessage(err));
}
function hasMessageThreadIdParam(params) {
    if (!params) {
        return false;
    }
    const value = params.message_thread_id;
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (typeof value === "string") {
        return value.trim().length > 0;
    }
    return false;
}
function removeMessageThreadIdParam(params) {
    if (!params || !hasMessageThreadIdParam(params)) {
        return params;
    }
    const next = { ...params };
    delete next.message_thread_id;
    return Object.keys(next).length > 0 ? next : undefined;
}
function isTelegramHtmlParseError(err) {
    return PARSE_ERR_RE.test(formatErrorMessage(err));
}
function buildTelegramThreadReplyParams(params) {
    const messageThreadId = params.messageThreadId != null ? params.messageThreadId : params.targetMessageThreadId;
    const threadScope = params.chatType === "direct" ? "dm" : "forum";
    // Never blanket-strip DM message_thread_id by chat-id sign.
    // Telegram supports DM topics; stripping silently misroutes topic replies.
    // Keep thread id and rely on thread-not-found retry fallback for plain DMs.
    const threadSpec = messageThreadId != null ? { id: messageThreadId, scope: threadScope } : undefined;
    const threadIdParams = buildTelegramThreadParams(threadSpec);
    const threadParams = threadIdParams ? { ...threadIdParams } : {};
    if (params.replyToMessageId != null) {
        const replyToMessageId = Math.trunc(params.replyToMessageId);
        if (params.quoteText?.trim()) {
            threadParams.reply_parameters = {
                message_id: replyToMessageId,
                quote: params.quoteText.trim(),
            };
        }
        else {
            threadParams.reply_to_message_id = replyToMessageId;
        }
    }
    return threadParams;
}
async function withTelegramHtmlParseFallback(params) {
    try {
        return await params.requestHtml(params.label);
    }
    catch (err) {
        if (!isTelegramHtmlParseError(err)) {
            throw err;
        }
        if (params.verbose) {
            sendLogger.warn(`telegram ${params.label} failed with HTML parse error, retrying as plain text: ${formatErrorMessage(err)}`);
        }
        return await params.requestPlain(`${params.label}-plain`);
    }
}
function resolveTelegramApiContext(opts) {
    const cfg = opts.cfg ?? loadConfig();
    const account = resolveTelegramAccount({
        cfg,
        accountId: opts.accountId,
    });
    const token = resolveToken(opts.token, account);
    const client = resolveTelegramClientOptions(account);
    const api = (opts.api ?? new Bot(token, client ? { client } : undefined).api);
    return { cfg, account, api };
}
function createTelegramRequestWithDiag(params) {
    const request = createTelegramRetryRunner({
        retry: params.retry,
        configRetry: params.account.config.retry,
        verbose: params.verbose,
        ...(params.shouldRetry ? { shouldRetry: params.shouldRetry } : {}),
    });
    const logHttpError = createTelegramHttpLogger(params.cfg);
    return (fn, label, options) => {
        const runRequest = () => request(fn, label);
        const call = params.useApiErrorLogging === false
            ? runRequest()
            : withTelegramApiErrorLogging({
                operation: label ?? "request",
                fn: runRequest,
                ...(options?.shouldLog ? { shouldLog: options.shouldLog } : {}),
            });
        return call.catch((err) => {
            logHttpError(label ?? "request", err);
            throw err;
        });
    };
}
function wrapTelegramChatNotFoundError(err, params) {
    if (!CHAT_NOT_FOUND_RE.test(formatErrorMessage(err))) {
        return err;
    }
    return new Error([
        `Telegram send failed: chat not found (chat_id=${params.chatId}).`,
        "Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
        `Input was: ${JSON.stringify(params.input)}.`,
    ].join(" "));
}
async function withTelegramThreadFallback(params, label, verbose, attempt) {
    try {
        return await attempt(params, label);
    }
    catch (err) {
        // Do not widen this fallback to cover "chat not found".
        // chat-not-found is routing/auth/membership/token; stripping thread IDs hides root cause.
        if (!hasMessageThreadIdParam(params) || !isTelegramThreadNotFoundError(err)) {
            throw err;
        }
        if (verbose) {
            sendLogger.warn(`telegram ${label} failed with message_thread_id, retrying without thread: ${formatErrorMessage(err)}`);
        }
        const retriedParams = removeMessageThreadIdParam(params);
        return await attempt(retriedParams, `${label}-threadless`);
    }
}
function createRequestWithChatNotFound(params) {
    return async (fn, label) => params.requestWithDiag(fn, label).catch((err) => {
        throw wrapTelegramChatNotFoundError(err, {
            chatId: params.chatId,
            input: params.input,
        });
    });
}
export function buildInlineKeyboard(buttons) {
    if (!buttons?.length) {
        return undefined;
    }
    const rows = buttons
        .map((row) => row
        .filter((button) => button?.text && button?.callback_data)
        .map((button) => ({
        text: button.text,
        callback_data: button.callback_data,
        ...(button.style ? { style: button.style } : {}),
    })))
        .filter((row) => row.length > 0);
    if (rows.length === 0) {
        return undefined;
    }
    return { inline_keyboard: rows };
}
export async function sendMessageTelegram(to, text, opts = {}) {
    const { cfg, account, api } = resolveTelegramApiContext(opts);
    const target = parseTelegramTarget(to);
    const chatId = await resolveAndPersistChatId({
        cfg,
        api,
        lookupTarget: target.chatId,
        persistTarget: to,
        verbose: opts.verbose,
    });
    const mediaUrl = opts.mediaUrl?.trim();
    const replyMarkup = buildInlineKeyboard(opts.buttons);
    const threadParams = buildTelegramThreadReplyParams({
        targetMessageThreadId: target.messageThreadId,
        messageThreadId: opts.messageThreadId,
        chatType: target.chatType,
        replyToMessageId: opts.replyToMessageId,
        quoteText: opts.quoteText,
    });
    const hasThreadParams = Object.keys(threadParams).length > 0;
    const requestWithDiag = createTelegramRequestWithDiag({
        cfg,
        account,
        retry: opts.retry,
        verbose: opts.verbose,
        shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
    });
    const requestWithChatNotFound = createRequestWithChatNotFound({
        requestWithDiag,
        chatId,
        input: to,
    });
    const textMode = opts.textMode ?? "markdown";
    const tableMode = resolveMarkdownTableMode({
        cfg,
        channel: "telegram",
        accountId: account.accountId,
    });
    const renderHtmlText = (value) => renderTelegramHtmlText(value, { textMode, tableMode });
    // Resolve link preview setting from config (default: enabled).
    const linkPreviewEnabled = account.config.linkPreview ?? true;
    const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };
    const sendTelegramText = async (rawText, params, fallbackText) => {
        return await withTelegramThreadFallback(params, "message", opts.verbose, async (effectiveParams, label) => {
            const htmlText = renderHtmlText(rawText);
            const baseParams = effectiveParams ? { ...effectiveParams } : {};
            if (linkPreviewOptions) {
                baseParams.link_preview_options = linkPreviewOptions;
            }
            const hasBaseParams = Object.keys(baseParams).length > 0;
            const sendParams = {
                parse_mode: "HTML",
                ...baseParams,
                ...(opts.silent === true ? { disable_notification: true } : {}),
            };
            return await withTelegramHtmlParseFallback({
                label,
                verbose: opts.verbose,
                requestHtml: (retryLabel) => requestWithChatNotFound(() => api.sendMessage(chatId, htmlText, sendParams), retryLabel),
                requestPlain: (retryLabel) => {
                    const plainParams = hasBaseParams
                        ? baseParams
                        : undefined;
                    return requestWithChatNotFound(() => plainParams
                        ? api.sendMessage(chatId, fallbackText ?? rawText, plainParams)
                        : api.sendMessage(chatId, fallbackText ?? rawText), retryLabel);
                },
            });
        });
    };
    if (mediaUrl) {
        const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({
            maxBytes: opts.maxBytes,
            mediaLocalRoots: opts.mediaLocalRoots,
        }));
        const kind = mediaKindFromMime(media.contentType ?? undefined);
        const isGif = isGifMedia({
            contentType: media.contentType,
            fileName: media.fileName,
        });
        const isVideoNote = kind === "video" && opts.asVideoNote === true;
        const fileName = media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind)) ?? "file";
        const file = new InputFile(media.buffer, fileName);
        let caption;
        let followUpText;
        if (isVideoNote) {
            caption = undefined;
            followUpText = text.trim() ? text : undefined;
        }
        else {
            const split = splitTelegramCaption(text);
            caption = split.caption;
            followUpText = split.followUpText;
        }
        const htmlCaption = caption ? renderHtmlText(caption) : undefined;
        // If text exceeds Telegram's caption limit, send media without caption
        // then send text as a separate follow-up message.
        const needsSeparateText = Boolean(followUpText);
        // When splitting, put reply_markup only on the follow-up text (the "main" content),
        // not on the media message.
        const baseMediaParams = {
            ...(hasThreadParams ? threadParams : {}),
            ...(!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}),
        };
        const mediaParams = {
            ...(htmlCaption ? { caption: htmlCaption, parse_mode: "HTML" } : {}),
            ...baseMediaParams,
            ...(opts.silent === true ? { disable_notification: true } : {}),
        };
        const sendMedia = async (label, sender) => await withTelegramThreadFallback(mediaParams, label, opts.verbose, async (effectiveParams, retryLabel) => requestWithChatNotFound(() => sender(effectiveParams), retryLabel));
        const mediaSender = (() => {
            if (isGif) {
                return {
                    label: "animation",
                    sender: (effectiveParams) => api.sendAnimation(chatId, file, effectiveParams),
                };
            }
            if (kind === "image") {
                return {
                    label: "photo",
                    sender: (effectiveParams) => api.sendPhoto(chatId, file, effectiveParams),
                };
            }
            if (kind === "video") {
                if (isVideoNote) {
                    return {
                        label: "video_note",
                        sender: (effectiveParams) => api.sendVideoNote(chatId, file, effectiveParams),
                    };
                }
                return {
                    label: "video",
                    sender: (effectiveParams) => api.sendVideo(chatId, file, effectiveParams),
                };
            }
            if (kind === "audio") {
                const { useVoice } = resolveTelegramVoiceSend({
                    wantsVoice: opts.asVoice === true, // default false (backward compatible)
                    contentType: media.contentType,
                    fileName,
                    logFallback: logVerbose,
                });
                if (useVoice) {
                    return {
                        label: "voice",
                        sender: (effectiveParams) => api.sendVoice(chatId, file, effectiveParams),
                    };
                }
                return {
                    label: "audio",
                    sender: (effectiveParams) => api.sendAudio(chatId, file, effectiveParams),
                };
            }
            return {
                label: "document",
                sender: (effectiveParams) => api.sendDocument(chatId, file, effectiveParams),
            };
        })();
        const result = await sendMedia(mediaSender.label, mediaSender.sender);
        const mediaMessageId = resolveTelegramMessageIdOrThrow(result, "media send");
        const resolvedChatId = String(result?.chat?.id ?? chatId);
        recordSentMessage(chatId, mediaMessageId);
        recordChannelActivity({
            channel: "telegram",
            accountId: account.accountId,
            direction: "outbound",
        });
        // If text was too long for a caption, send it as a separate follow-up message.
        // Use HTML conversion so markdown renders like captions.
        if (needsSeparateText && followUpText) {
            const textParams = hasThreadParams || replyMarkup
                ? {
                    ...threadParams,
                    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                }
                : undefined;
            const textRes = await sendTelegramText(followUpText, textParams);
            // Return the text message ID as the "main" message (it's the actual content).
            const textMessageId = resolveTelegramMessageIdOrThrow(textRes, "text follow-up send");
            recordSentMessage(chatId, textMessageId);
            return {
                messageId: String(textMessageId),
                chatId: resolvedChatId,
            };
        }
        return { messageId: String(mediaMessageId), chatId: resolvedChatId };
    }
    if (!text || !text.trim()) {
        throw new Error("Message must be non-empty for Telegram sends");
    }
    const textParams = hasThreadParams || replyMarkup
        ? {
            ...threadParams,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
        : undefined;
    const res = await sendTelegramText(text, textParams, opts.plainText);
    const messageId = resolveTelegramMessageIdOrThrow(res, "text send");
    recordSentMessage(chatId, messageId);
    recordChannelActivity({
        channel: "telegram",
        accountId: account.accountId,
        direction: "outbound",
    });
    return { messageId: String(messageId), chatId: String(res?.chat?.id ?? chatId) };
}
export async function reactMessageTelegram(chatIdInput, messageIdInput, emoji, opts = {}) {
    const { cfg, account, api } = resolveTelegramApiContext(opts);
    const rawTarget = String(chatIdInput);
    const chatId = await resolveAndPersistChatId({
        cfg,
        api,
        lookupTarget: rawTarget,
        persistTarget: rawTarget,
        verbose: opts.verbose,
    });
    const messageId = normalizeMessageId(messageIdInput);
    const requestWithDiag = createTelegramRequestWithDiag({
        cfg,
        account,
        retry: opts.retry,
        verbose: opts.verbose,
        shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
    });
    const remove = opts.remove === true;
    const trimmedEmoji = emoji.trim();
    // Build the reaction array. We cast emoji to the grammY union type since
    // Telegram validates emoji server-side; invalid emojis fail gracefully.
    const reactions = remove || !trimmedEmoji
        ? []
        : [{ type: "emoji", emoji: trimmedEmoji }];
    if (typeof api.setMessageReaction !== "function") {
        throw new Error("Telegram reactions are unavailable in this bot API.");
    }
    try {
        await requestWithDiag(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/REACTION_INVALID/i.test(msg)) {
            return { ok: false, warning: `Reaction unavailable: ${trimmedEmoji}` };
        }
        throw err;
    }
    return { ok: true };
}
export async function deleteMessageTelegram(chatIdInput, messageIdInput, opts = {}) {
    const { cfg, account, api } = resolveTelegramApiContext(opts);
    const rawTarget = String(chatIdInput);
    const chatId = await resolveAndPersistChatId({
        cfg,
        api,
        lookupTarget: rawTarget,
        persistTarget: rawTarget,
        verbose: opts.verbose,
    });
    const messageId = normalizeMessageId(messageIdInput);
    const requestWithDiag = createTelegramRequestWithDiag({
        cfg,
        account,
        retry: opts.retry,
        verbose: opts.verbose,
        shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
    });
    await requestWithDiag(() => api.deleteMessage(chatId, messageId), "deleteMessage");
    logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
    return { ok: true };
}
export async function editMessageTelegram(chatIdInput, messageIdInput, text, opts = {}) {
    const { cfg, account, api } = resolveTelegramApiContext({
        ...opts,
        cfg: opts.cfg,
    });
    const rawTarget = String(chatIdInput);
    const chatId = await resolveAndPersistChatId({
        cfg,
        api,
        lookupTarget: rawTarget,
        persistTarget: rawTarget,
        verbose: opts.verbose,
    });
    const messageId = normalizeMessageId(messageIdInput);
    const requestWithDiag = createTelegramRequestWithDiag({
        cfg,
        account,
        retry: opts.retry,
        verbose: opts.verbose,
    });
    const requestWithEditShouldLog = (fn, label, shouldLog) => requestWithDiag(fn, label, shouldLog ? { shouldLog } : undefined);
    const textMode = opts.textMode ?? "markdown";
    const tableMode = resolveMarkdownTableMode({
        cfg,
        channel: "telegram",
        accountId: account.accountId,
    });
    const htmlText = renderTelegramHtmlText(text, { textMode, tableMode });
    // Reply markup semantics:
    // - buttons === undefined → don't send reply_markup (keep existing)
    // - buttons is [] (or filters to empty) → send { inline_keyboard: [] } (remove)
    // - otherwise → send built inline keyboard
    const shouldTouchButtons = opts.buttons !== undefined;
    const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : undefined;
    const replyMarkup = shouldTouchButtons ? (builtKeyboard ?? { inline_keyboard: [] }) : undefined;
    const editParams = {
        parse_mode: "HTML",
    };
    if (opts.linkPreview === false) {
        editParams.link_preview_options = { is_disabled: true };
    }
    if (replyMarkup !== undefined) {
        editParams.reply_markup = replyMarkup;
    }
    const plainParams = {};
    if (opts.linkPreview === false) {
        plainParams.link_preview_options = { is_disabled: true };
    }
    if (replyMarkup !== undefined) {
        plainParams.reply_markup = replyMarkup;
    }
    try {
        await withTelegramHtmlParseFallback({
            label: "editMessage",
            verbose: opts.verbose,
            requestHtml: (retryLabel) => requestWithEditShouldLog(() => api.editMessageText(chatId, messageId, htmlText, editParams), retryLabel, (err) => !isTelegramMessageNotModifiedError(err)),
            requestPlain: (retryLabel) => requestWithEditShouldLog(() => Object.keys(plainParams).length > 0
                ? api.editMessageText(chatId, messageId, text, plainParams)
                : api.editMessageText(chatId, messageId, text), retryLabel, (plainErr) => !isTelegramMessageNotModifiedError(plainErr)),
        });
    }
    catch (err) {
        if (isTelegramMessageNotModifiedError(err)) {
            // no-op: Telegram reports message content unchanged, treat as success
        }
        else {
            throw err;
        }
    }
    logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
    return { ok: true, messageId: String(messageId), chatId };
}
function inferFilename(kind) {
    switch (kind) {
        case "image":
            return "image.jpg";
        case "video":
            return "video.mp4";
        case "audio":
            return "audio.ogg";
        default:
            return "file.bin";
    }
}
/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export async function sendStickerTelegram(to, fileId, opts = {}) {
    if (!fileId?.trim()) {
        throw new Error("Telegram sticker file_id is required");
    }
    const { cfg, account, api } = resolveTelegramApiContext(opts);
    const target = parseTelegramTarget(to);
    const chatId = await resolveAndPersistChatId({
        cfg,
        api,
        lookupTarget: target.chatId,
        persistTarget: to,
        verbose: opts.verbose,
    });
    const threadParams = buildTelegramThreadReplyParams({
        targetMessageThreadId: target.messageThreadId,
        messageThreadId: opts.messageThreadId,
        chatType: target.chatType,
        replyToMessageId: opts.replyToMessageId,
    });
    const hasThreadParams = Object.keys(threadParams).length > 0;
    const requestWithDiag = createTelegramRequestWithDiag({
        cfg,
        account,
        retry: opts.retry,
        verbose: opts.verbose,
        useApiErrorLogging: false,
    });
    const requestWithChatNotFound = createRequestWithChatNotFound({
        requestWithDiag,
        chatId,
        input: to,
    });
    const stickerParams = hasThreadParams ? threadParams : undefined;
    const result = await withTelegramThreadFallback(stickerParams, "sticker", opts.verbose, async (effectiveParams, label) => requestWithChatNotFound(() => api.sendSticker(chatId, fileId.trim(), effectiveParams), label));
    const messageId = resolveTelegramMessageIdOrThrow(result, "sticker send");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    recordSentMessage(chatId, messageId);
    recordChannelActivity({
        channel: "telegram",
        accountId: account.accountId,
        direction: "outbound",
    });
    return { messageId: String(messageId), chatId: resolvedChatId };
}
/**
 * Send a poll to a Telegram chat.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param poll - Poll input with question, options, maxSelections, and optional durationHours
 * @param opts - Optional configuration
 */
export async function sendPollTelegram(to, poll, opts = {}) {
    const { cfg, account, api } = resolveTelegramApiContext(opts);
    const target = parseTelegramTarget(to);
    const chatId = await resolveAndPersistChatId({
        cfg,
        api,
        lookupTarget: target.chatId,
        persistTarget: to,
        verbose: opts.verbose,
    });
    // Normalize the poll input (validates question, options, maxSelections)
    const normalizedPoll = normalizePollInput(poll, { maxOptions: 10 });
    const threadParams = buildTelegramThreadReplyParams({
        targetMessageThreadId: target.messageThreadId,
        messageThreadId: opts.messageThreadId,
        chatType: target.chatType,
        replyToMessageId: opts.replyToMessageId,
    });
    // Build poll options as simple strings (Grammy accepts string[] or InputPollOption[])
    const pollOptions = normalizedPoll.options;
    const requestWithDiag = createTelegramRequestWithDiag({
        cfg,
        account,
        retry: opts.retry,
        verbose: opts.verbose,
        shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
    });
    const requestWithChatNotFound = createRequestWithChatNotFound({
        requestWithDiag,
        chatId,
        input: to,
    });
    const durationSeconds = normalizedPoll.durationSeconds;
    if (durationSeconds === undefined && normalizedPoll.durationHours !== undefined) {
        throw new Error("Telegram poll durationHours is not supported. Use durationSeconds (5-600) instead.");
    }
    if (durationSeconds !== undefined && (durationSeconds < 5 || durationSeconds > 600)) {
        throw new Error("Telegram poll durationSeconds must be between 5 and 600");
    }
    // Build poll parameters following Grammy's api.sendPoll signature
    // sendPoll(chat_id, question, options, other?, signal?)
    const pollParams = {
        allows_multiple_answers: normalizedPoll.maxSelections > 1,
        is_anonymous: opts.isAnonymous ?? true,
        ...(durationSeconds !== undefined ? { open_period: durationSeconds } : {}),
        ...(Object.keys(threadParams).length > 0 ? threadParams : {}),
        ...(opts.silent === true ? { disable_notification: true } : {}),
    };
    const result = await withTelegramThreadFallback(pollParams, "poll", opts.verbose, async (effectiveParams, label) => requestWithChatNotFound(() => api.sendPoll(chatId, normalizedPoll.question, pollOptions, effectiveParams), label));
    const messageId = resolveTelegramMessageIdOrThrow(result, "poll send");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    const pollId = result?.poll?.id;
    recordSentMessage(chatId, messageId);
    recordChannelActivity({
        channel: "telegram",
        accountId: account.accountId,
        direction: "outbound",
    });
    return { messageId: String(messageId), chatId: resolvedChatId, pollId };
}
/**
 * Create a forum topic in a Telegram supergroup.
 * Requires the bot to have `can_manage_topics` permission.
 *
 * @param chatId - Supergroup chat ID
 * @param name - Topic name (1-128 characters)
 * @param opts - Optional configuration
 */
export async function createForumTopicTelegram(chatId, name, opts = {}) {
    if (!name?.trim()) {
        throw new Error("Forum topic name is required");
    }
    const trimmedName = name.trim();
    if (trimmedName.length > 128) {
        throw new Error("Forum topic name must be 128 characters or fewer");
    }
    const cfg = loadConfig();
    const account = resolveTelegramAccount({
        cfg,
        accountId: opts.accountId,
    });
    const token = resolveToken(opts.token, account);
    // Accept topic-qualified targets (e.g. telegram:group:<id>:topic:<thread>)
    // but createForumTopic must always target the base supergroup chat id.
    const client = resolveTelegramClientOptions(account);
    const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
    const target = parseTelegramTarget(chatId);
    const normalizedChatId = await resolveAndPersistChatId({
        cfg,
        api,
        lookupTarget: target.chatId,
        persistTarget: chatId,
        verbose: opts.verbose,
    });
    const request = createTelegramRetryRunner({
        retry: opts.retry,
        configRetry: account.config.retry,
        verbose: opts.verbose,
        shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
    });
    const logHttpError = createTelegramHttpLogger(cfg);
    const requestWithDiag = (fn, label) => withTelegramApiErrorLogging({
        operation: label ?? "request",
        fn: () => request(fn, label),
    }).catch((err) => {
        logHttpError(label ?? "request", err);
        throw err;
    });
    const extra = {};
    if (opts.iconColor != null) {
        extra.icon_color = opts.iconColor;
    }
    if (opts.iconCustomEmojiId?.trim()) {
        extra.icon_custom_emoji_id = opts.iconCustomEmojiId.trim();
    }
    const hasExtra = Object.keys(extra).length > 0;
    const result = await requestWithDiag(() => api.createForumTopic(normalizedChatId, trimmedName, hasExtra ? extra : undefined), "createForumTopic");
    const topicId = result.message_thread_id;
    recordChannelActivity({
        channel: "telegram",
        accountId: account.accountId,
        direction: "outbound",
    });
    return {
        topicId,
        name: result.name ?? trimmedName,
        chatId: normalizedChatId,
    };
}
