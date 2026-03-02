import { type Bot, GrammyError, InputFile } from "grammy";
import { chunkMarkdownTextWithMode, type ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/config.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import { danger, logVerbose, warn } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { retryAsync } from "../../infra/retry.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { isGifMedia } from "../../media/mime.js";
import { saveMediaBuffer } from "../../media/store.js";
import type { RuntimeEnv } from "../../runtime.js";
import { loadWebMedia } from "../../web/media.js";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import type { TelegramInlineButtons } from "../button-types.js";
import { splitTelegramCaption } from "../caption.js";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  wrapFileReferencesInHtml,
} from "../format.js";
import { buildInlineKeyboard } from "../send.js";
import { cacheSticker, getCachedSticker } from "../sticker-cache.js";
import { resolveTelegramVoiceSend } from "../voice.js";
import {
  buildTelegramThreadParams,
  resolveTelegramMediaPlaceholder,
  resolveTelegramReplyId,
  type TelegramThreadSpec,
} from "./helpers.js";
import type { StickerMetadata, TelegramContext } from "./types.js";

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const EMPTY_TEXT_ERR_RE = /message text is empty/i;
const VOICE_FORBIDDEN_RE = /VOICE_MESSAGES_FORBIDDEN/;
const CAPTION_TOO_LONG_RE = /caption is too long/i;
const FILE_TOO_BIG_RE = /file is too big/i;
const THREAD_NOT_FOUND_RE = /message thread not found/i;
const TELEGRAM_MEDIA_SSRF_POLICY = {
  // Telegram file downloads should trust api.telegram.org even when DNS/proxy
  // resolution maps to private/internal ranges in restricted networks.
  allowedHostnames: ["api.telegram.org"],
  allowRfc2544BenchmarkRange: true,
};

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  chatId: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  mediaLocalRoots?: readonly string[];
  replyToMode: ReplyToMode;
  textLimit: number;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  /** Callback invoked before sending a voice message to switch typing indicator. */
  onVoiceRecording?: () => Promise<void> | void;
  /** Controls whether link previews are shown. Default: true (previews enabled). */
  linkPreview?: boolean;
  /** Optional quote text for Telegram reply_parameters. */
  replyQuoteText?: string;
}): Promise<{ delivered: boolean }> {
  const {
    replies,
    chatId,
    runtime,
    bot,
    replyToMode,
    textLimit,
    thread,
    linkPreview,
    replyQuoteText,
  } = params;
  const chunkMode = params.chunkMode ?? "length";
  let hasReplied = false;
  let hasDelivered = false;
  const markDelivered = () => {
    hasDelivered = true;
  };
  const chunkText = (markdown: string) => {
    const markdownChunks =
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(markdown, textLimit, chunkMode)
        : [markdown];
    const chunks: ReturnType<typeof markdownToTelegramChunks> = [];
    for (const chunk of markdownChunks) {
      const nested = markdownToTelegramChunks(chunk, textLimit, { tableMode: params.tableMode });
      if (!nested.length && chunk) {
        chunks.push({
          html: wrapFileReferencesInHtml(
            markdownToTelegramHtml(chunk, { tableMode: params.tableMode, wrapFileRefs: false }),
          ),
          text: chunk,
        });
        continue;
      }
      chunks.push(...nested);
    }
    return chunks;
  };
  for (const reply of replies) {
    const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("telegram reply has audioAsVoice without media/text; skipping");
        continue;
      }
      runtime.error?.(danger("reply missing text/media"));
      continue;
    }
    const replyToId = replyToMode === "off" ? undefined : resolveTelegramReplyId(reply.replyToId);
    // Evaluate lazily so `hasReplied` is checked at each send site.
    // When replyToMode is "first", only the first chunk/media item gets the reply-to.
    const resolveReplyTo = () =>
      replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined;
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];
    const telegramData = reply.channelData?.telegram as
      | { buttons?: TelegramInlineButtons }
      | undefined;
    const replyMarkup = buildInlineKeyboard(telegramData?.buttons);
    if (mediaList.length === 0) {
      const chunks = chunkText(reply.text || "");
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (!chunk) {
          continue;
        }
        // Only attach buttons to the first chunk.
        const shouldAttachButtons = i === 0 && replyMarkup;
        const replyToForChunk = resolveReplyTo();
        await sendTelegramText(bot, chatId, chunk.html, runtime, {
          replyToMessageId: replyToForChunk,
          replyQuoteText,
          thread,
          textMode: "html",
          plainText: chunk.text,
          linkPreview,
          replyMarkup: shouldAttachButtons ? replyMarkup : undefined,
        });
        if (replyToForChunk && !hasReplied) {
          hasReplied = true;
        }
        markDelivered();
      }
      continue;
    }
    // media with optional caption on first item
    let first = true;
    // Track if we need to send a follow-up text message after media
    // (when caption exceeds Telegram's 1024-char limit)
    let pendingFollowUpText: string | undefined;
    for (const mediaUrl of mediaList) {
      const isFirstMedia = first;
      const media = await loadWebMedia(mediaUrl, {
        localRoots: params.mediaLocalRoots,
      });
      const kind = mediaKindFromMime(media.contentType ?? undefined);
      const isGif = isGifMedia({
        contentType: media.contentType,
        fileName: media.fileName,
      });
      const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
      const file = new InputFile(media.buffer, fileName);
      // Caption only on first item; if text exceeds limit, defer to follow-up message.
      const { caption, followUpText } = splitTelegramCaption(
        isFirstMedia ? (reply.text ?? undefined) : undefined,
      );
      const htmlCaption = caption
        ? renderTelegramHtmlText(caption, { tableMode: params.tableMode })
        : undefined;
      if (followUpText) {
        pendingFollowUpText = followUpText;
      }
      first = false;
      const replyToMessageId = resolveReplyTo();
      const shouldAttachButtonsToMedia = isFirstMedia && replyMarkup && !followUpText;
      const mediaParams: Record<string, unknown> = {
        caption: htmlCaption,
        ...(htmlCaption ? { parse_mode: "HTML" } : {}),
        ...(shouldAttachButtonsToMedia ? { reply_markup: replyMarkup } : {}),
        ...buildTelegramSendParams({
          replyToMessageId,
          thread,
        }),
      };
      if (isGif) {
        await sendTelegramWithThreadFallback({
          operation: "sendAnimation",
          runtime,
          thread,
          requestParams: mediaParams,
          send: (effectiveParams) => bot.api.sendAnimation(chatId, file, { ...effectiveParams }),
        });
        markDelivered();
      } else if (kind === "image") {
        await sendTelegramWithThreadFallback({
          operation: "sendPhoto",
          runtime,
          thread,
          requestParams: mediaParams,
          send: (effectiveParams) => bot.api.sendPhoto(chatId, file, { ...effectiveParams }),
        });
        markDelivered();
      } else if (kind === "video") {
        await sendTelegramWithThreadFallback({
          operation: "sendVideo",
          runtime,
          thread,
          requestParams: mediaParams,
          send: (effectiveParams) => bot.api.sendVideo(chatId, file, { ...effectiveParams }),
        });
        markDelivered();
      } else if (kind === "audio") {
        const { useVoice } = resolveTelegramVoiceSend({
          wantsVoice: reply.audioAsVoice === true, // default false (backward compatible)
          contentType: media.contentType,
          fileName,
          logFallback: logVerbose,
        });
        if (useVoice) {
          // Voice message - displays as round playable bubble (opt-in via [[audio_as_voice]])
          // Switch typing indicator to record_voice before sending.
          await params.onVoiceRecording?.();
          try {
            await sendTelegramWithThreadFallback({
              operation: "sendVoice",
              runtime,
              thread,
              requestParams: mediaParams,
              shouldLog: (err) => !isVoiceMessagesForbidden(err),
              send: (effectiveParams) => bot.api.sendVoice(chatId, file, { ...effectiveParams }),
            });
            markDelivered();
          } catch (voiceErr) {
            // Fall back to text if voice messages are forbidden in this chat.
            if (isVoiceMessagesForbidden(voiceErr)) {
              const fallbackText = reply.text;
              if (!fallbackText || !fallbackText.trim()) {
                throw voiceErr;
              }
              logVerbose(
                "telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text",
              );
              await sendTelegramVoiceFallbackText({
                bot,
                chatId,
                runtime,
                text: fallbackText,
                chunkText,
                replyToId: resolveReplyTo(),
                thread,
                linkPreview,
                replyMarkup,
                replyQuoteText,
              });
              if (replyToId && !hasReplied) {
                hasReplied = true;
              }
              markDelivered();
              continue;
            }
            if (isCaptionTooLong(voiceErr)) {
              logVerbose(
                "telegram sendVoice caption too long; resending voice without caption + text separately",
              );
              const noCaptionParams = { ...mediaParams };
              delete noCaptionParams.caption;
              delete noCaptionParams.parse_mode;
              await withTelegramApiErrorLogging({
                operation: "sendVoice",
                runtime,
                fn: () => bot.api.sendVoice(chatId, file, { ...noCaptionParams }),
              });
              markDelivered();
              const fallbackText = reply.text;
              if (fallbackText?.trim()) {
                await sendTelegramVoiceFallbackText({
                  bot,
                  chatId,
                  runtime,
                  text: fallbackText,
                  chunkText,
                  replyToId: undefined,
                  thread,
                  linkPreview,
                  replyMarkup,
                });
              }
              if (replyToMessageIdForPayload && !hasReplied) {
                hasReplied = true;
              }
              continue;
            }
            throw voiceErr;
          }
        } else {
          // Audio file - displays with metadata (title, duration) - DEFAULT
          await sendTelegramWithThreadFallback({
            operation: "sendAudio",
            runtime,
            thread,
            requestParams: mediaParams,
            send: (effectiveParams) => bot.api.sendAudio(chatId, file, { ...effectiveParams }),
          });
          markDelivered();
        }
      } else {
        await sendTelegramWithThreadFallback({
          operation: "sendDocument",
          runtime,
          thread,
          requestParams: mediaParams,
          send: (effectiveParams) => bot.api.sendDocument(chatId, file, { ...effectiveParams }),
        });
        markDelivered();
      }
      if (replyToId && !hasReplied) {
        hasReplied = true;
      }
      // Send deferred follow-up text right after the first media item.
      // Chunk it in case it's extremely long (same logic as text-only replies).
      if (pendingFollowUpText && isFirstMedia) {
        const chunks = chunkText(pendingFollowUpText);
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          const replyToForFollowUp = resolveReplyTo();
          await sendTelegramText(bot, chatId, chunk.html, runtime, {
            replyToMessageId: replyToForFollowUp,
            thread,
            textMode: "html",
            plainText: chunk.text,
            linkPreview,
            replyMarkup: i === 0 ? replyMarkup : undefined,
          });
          if (replyToForFollowUp && !hasReplied) {
            hasReplied = true;
          }
          markDelivered();
        }
        pendingFollowUpText = undefined;
      }
    }
  }

  return { delivered: hasDelivered };
}

export async function resolveMedia(
  ctx: TelegramContext,
  maxBytes: number,
  token: string,
  proxyFetch?: typeof fetch,
): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
  stickerMetadata?: StickerMetadata;
} | null> {
  const msg = ctx.message;
  const downloadAndSaveTelegramFile = async (filePath: string, fetchImpl: typeof fetch) => {
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fetched = await fetchRemoteMedia({
      url,
      fetchImpl,
      filePathHint: filePath,
      maxBytes,
      ssrfPolicy: TELEGRAM_MEDIA_SSRF_POLICY,
    });
    const originalName = fetched.fileName ?? filePath;
    return saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes, originalName);
  };

  // Handle stickers separately - only static stickers (WEBP) are supported
  if (msg.sticker) {
    const sticker = msg.sticker;
    // Skip animated (TGS) and video (WEBM) stickers - only static WEBP supported
    if (sticker.is_animated || sticker.is_video) {
      logVerbose("telegram: skipping animated/video sticker (only static stickers supported)");
      return null;
    }
    if (!sticker.file_id) {
      return null;
    }

    try {
      const file = await ctx.getFile();
      if (!file.file_path) {
        logVerbose("telegram: getFile returned no file_path for sticker");
        return null;
      }
      const fetchImpl = proxyFetch ?? globalThis.fetch;
      if (!fetchImpl) {
        logVerbose("telegram: fetch not available for sticker download");
        return null;
      }
      const saved = await downloadAndSaveTelegramFile(file.file_path, fetchImpl);

      // Check sticker cache for existing description
      const cached = sticker.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
      if (cached) {
        logVerbose(`telegram: sticker cache hit for ${sticker.file_unique_id}`);
        const fileId = sticker.file_id ?? cached.fileId;
        const emoji = sticker.emoji ?? cached.emoji;
        const setName = sticker.set_name ?? cached.setName;
        if (fileId !== cached.fileId || emoji !== cached.emoji || setName !== cached.setName) {
          // Refresh cached sticker metadata on hits so sends/searches use latest file_id.
          cacheSticker({
            ...cached,
            fileId,
            emoji,
            setName,
          });
        }
        return {
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:sticker>",
          stickerMetadata: {
            emoji,
            setName,
            fileId,
            fileUniqueId: sticker.file_unique_id,
            cachedDescription: cached.description,
          },
        };
      }

      // Cache miss - return metadata for vision processing
      return {
        path: saved.path,
        contentType: saved.contentType,
        placeholder: "<media:sticker>",
        stickerMetadata: {
          emoji: sticker.emoji ?? undefined,
          setName: sticker.set_name ?? undefined,
          fileId: sticker.file_id,
          fileUniqueId: sticker.file_unique_id,
        },
      };
    } catch (err) {
      logVerbose(`telegram: failed to process sticker: ${String(err)}`);
      return null;
    }
  }

  const m =
    msg.photo?.[msg.photo.length - 1] ??
    msg.video ??
    msg.video_note ??
    msg.document ??
    msg.audio ??
    msg.voice;
  if (!m?.file_id) {
    return null;
  }

  let file: { file_path?: string };
  try {
    file = await retryAsync(() => ctx.getFile(), {
      attempts: 3,
      minDelayMs: 1000,
      maxDelayMs: 4000,
      jitter: 0.2,
      label: "telegram:getFile",
      shouldRetry: isRetryableGetFileError,
      onRetry: ({ attempt, maxAttempts }) =>
        logVerbose(`telegram: getFile retry ${attempt}/${maxAttempts}`),
    });
  } catch (err) {
    // Handle "file is too big" separately - Telegram Bot API has a 20MB download limit
    if (isFileTooBigError(err)) {
      logVerbose(
        warn(
          "telegram: getFile failed - file exceeds Telegram Bot API 20MB limit; skipping attachment",
        ),
      );
      return null;
    }
    // All retries exhausted — return null so the message still reaches the agent
    // with a type-based placeholder (e.g. <media:audio>) instead of being dropped.
    logVerbose(`telegram: getFile failed after retries: ${String(err)}`);
    return null;
  }
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const fetchImpl = proxyFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  const saved = await downloadAndSaveTelegramFile(file.file_path, fetchImpl);
  const placeholder = resolveTelegramMediaPlaceholder(msg) ?? "<media:document>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}

function isVoiceMessagesForbidden(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return VOICE_FORBIDDEN_RE.test(err.description);
  }
  return VOICE_FORBIDDEN_RE.test(formatErrorMessage(err));
}

function isCaptionTooLong(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return CAPTION_TOO_LONG_RE.test(err.description);
  }
  return CAPTION_TOO_LONG_RE.test(formatErrorMessage(err));
}

/**
 * Returns true if the error is Telegram's "file is too big" error.
 * This happens when trying to download files >20MB via the Bot API.
 * Unlike network errors, this is a permanent error and should not be retried.
 */
function isFileTooBigError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return FILE_TOO_BIG_RE.test(err.description);
  }
  return FILE_TOO_BIG_RE.test(formatErrorMessage(err));
}

/**
 * Returns true if the error is a transient network error that should be retried.
 * Returns false for permanent errors like "file is too big" (400 Bad Request).
 */
function isRetryableGetFileError(err: unknown): boolean {
  // Don't retry "file is too big" - it's a permanent 400 error
  if (isFileTooBigError(err)) {
    return false;
  }
  // Retry all other errors (network issues, timeouts, etc.)
  return true;
}

async function sendTelegramVoiceFallbackText(opts: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  text: string;
  chunkText: (markdown: string) => ReturnType<typeof markdownToTelegramChunks>;
  replyToId?: number;
  thread?: TelegramThreadSpec | null;
  linkPreview?: boolean;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteText?: string;
}): Promise<void> {
  const chunks = opts.chunkText(opts.text);
  let appliedReplyTo = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const replyToForChunk = !appliedReplyTo ? opts.replyToId : undefined;
    await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
      replyToMessageId: replyToForChunk,
      replyQuoteText: opts.replyQuoteText,
      thread: opts.thread,
      textMode: "html",
      plainText: chunk.text,
      linkPreview: opts.linkPreview,
      replyMarkup: i === 0 ? opts.replyMarkup : undefined,
    });
    if (replyToForChunk) {
      appliedReplyTo = true;
    }
  }
}

function isTelegramThreadNotFoundError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return THREAD_NOT_FOUND_RE.test(err.description);
  }
  return THREAD_NOT_FOUND_RE.test(formatErrorMessage(err));
}

function hasMessageThreadIdParam(params: Record<string, unknown> | undefined): boolean {
  if (!params) {
    return false;
  }
  return typeof params.message_thread_id === "number";
}

function removeMessageThreadIdParam(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!params) {
    return {};
  }
  const { message_thread_id: _ignored, ...rest } = params;
  return rest;
}

async function sendTelegramWithThreadFallback<T>(params: {
  operation: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  requestParams: Record<string, unknown>;
  send: (effectiveParams: Record<string, unknown>) => Promise<T>;
  shouldLog?: (err: unknown) => boolean;
}): Promise<T> {
  const allowThreadlessRetry = params.thread?.scope === "dm";
  const hasThreadId = hasMessageThreadIdParam(params.requestParams);
  const shouldSuppressFirstErrorLog = (err: unknown) =>
    allowThreadlessRetry && hasThreadId && isTelegramThreadNotFoundError(err);
  const mergedShouldLog = params.shouldLog
    ? (err: unknown) => params.shouldLog!(err) && !shouldSuppressFirstErrorLog(err)
    : (err: unknown) => !shouldSuppressFirstErrorLog(err);

  try {
    return await withTelegramApiErrorLogging({
      operation: params.operation,
      runtime: params.runtime,
      shouldLog: mergedShouldLog,
      fn: () => params.send(params.requestParams),
    });
  } catch (err) {
    if (!allowThreadlessRetry || !hasThreadId || !isTelegramThreadNotFoundError(err)) {
      throw err;
    }
    const retryParams = removeMessageThreadIdParam(params.requestParams);
    params.runtime.log?.(
      `telegram ${params.operation}: message thread not found; retrying without message_thread_id`,
    );
    return await withTelegramApiErrorLogging({
      operation: `${params.operation} (threadless retry)`,
      runtime: params.runtime,
      fn: () => params.send(retryParams),
    });
  }
}

function buildTelegramSendParams(opts?: {
  replyToMessageId?: number;
  thread?: TelegramThreadSpec | null;
}): Record<string, unknown> {
  const threadParams = buildTelegramThreadParams(opts?.thread);
  const params: Record<string, unknown> = {};
  if (opts?.replyToMessageId) {
    params.reply_to_message_id = opts.replyToMessageId;
  }
  if (threadParams) {
    params.message_thread_id = threadParams.message_thread_id;
  }
  return params;
}

async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  opts?: {
    replyToMessageId?: number;
    replyQuoteText?: string;
    thread?: TelegramThreadSpec | null;
    textMode?: "markdown" | "html";
    plainText?: string;
    linkPreview?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  },
): Promise<number> {
  const baseParams = buildTelegramSendParams({
    replyToMessageId: opts?.replyToMessageId,
    thread: opts?.thread,
  });
  // Add link_preview_options when link preview is disabled.
  const linkPreviewEnabled = opts?.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };
  const textMode = opts?.textMode ?? "markdown";
  const htmlText = textMode === "html" ? text : markdownToTelegramHtml(text);
  const fallbackText = opts?.plainText ?? text;
  const hasFallbackText = fallbackText.trim().length > 0;
  const sendPlainFallback = async () => {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, fallbackText, {
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id} (plain)`);
    return res.message_id;
  };

  // Markdown can render to empty HTML for syntax-only chunks; recover with plain text.
  if (!htmlText.trim()) {
    if (!hasFallbackText) {
      throw new Error("telegram sendMessage failed: empty formatted text and empty plain fallback");
    }
    return await sendPlainFallback();
  }
  try {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      shouldLog: (err) => {
        const errText = formatErrorMessage(err);
        return !PARSE_ERR_RE.test(errText) && !EMPTY_TEXT_ERR_RE.test(errText);
      },
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, htmlText, {
          parse_mode: "HTML",
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id}`);
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText) || EMPTY_TEXT_ERR_RE.test(errText)) {
      if (!hasFallbackText) {
        throw err;
      }
      runtime.log?.(`telegram formatted send failed; retrying without formatting: ${errText}`);
      return await sendPlainFallback();
    }
    throw err;
  }
}
