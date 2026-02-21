import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  ReactionType,
  ReactionTypeEmoji,
} from "@grammyjs/types";
import { type ApiClientOptions, Bot, HttpError, InputFile } from "grammy";
import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { logVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import { formatErrorMessage, formatUncaughtError } from "../infra/errors.js";
import { createTelegramRetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mediaKindFromMime } from "../media/constants.js";
import { isGifMedia } from "../media/mime.js";
import { normalizePollInput, type PollInput } from "../polls.js";
import { loadWebMedia } from "../web/media.js";
import { type ResolvedTelegramAccount, resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { splitTelegramCaption } from "./caption.js";
import { resolveTelegramFetch } from "./fetch.js";
import { renderTelegramHtmlText } from "./format.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseTelegramTarget, stripTelegramInternalPrefixes } from "./targets.js";
import { resolveTelegramVoiceSend } from "./voice.js";

type TelegramApi = Bot["api"];
type TelegramApiOverride = Partial<TelegramApi>;

type TelegramSendOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  plainText?: string;
  /** Send audio as voice message (voice bubble) instead of audio file. Defaults to false. */
  asVoice?: boolean;
  /** Send video as video note (voice bubble) instead of regular video. Defaults to false. */
  asVideoNote?: boolean;
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Quote text for Telegram reply_parameters. */
  quoteText?: string;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Inline keyboard buttons (reply markup). */
  buttons?: TelegramInlineButtons;
};

type TelegramSendResult = {
  messageId: string;
  chatId: string;
};

type TelegramMessageLike = {
  message_id?: number;
  chat?: { id?: string | number };
};

type TelegramReactionOpts = {
  token?: string;
  accountId?: string;
  api?: TelegramApiOverride;
  remove?: boolean;
  verbose?: boolean;
  retry?: RetryConfig;
};

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const MESSAGE_NOT_MODIFIED_RE =
  /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const CHAT_NOT_FOUND_RE = /400: Bad Request: chat not found/i;
const sendLogger = createSubsystemLogger("telegram/send");
const diagLogger = createSubsystemLogger("telegram/diagnostic");

function createTelegramHttpLogger(cfg: ReturnType<typeof loadConfig>) {
  const enabled = isDiagnosticFlagEnabled("telegram.http", cfg);
  if (!enabled) {
    return () => {};
  }
  return (label: string, err: unknown) => {
    if (!(err instanceof HttpError)) {
      return;
    }
    const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
    diagLogger.warn(`telegram http error (${label}): ${detail}`);
  };
}

function resolveTelegramClientOptions(
  account: ResolvedTelegramAccount,
): ApiClientOptions | undefined {
  const proxyUrl = account.config.proxy?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const fetchImpl = resolveTelegramFetch(proxyFetch, {
    network: account.config.network,
  });
  const timeoutSeconds =
    typeof account.config.timeoutSeconds === "number" &&
    Number.isFinite(account.config.timeoutSeconds)
      ? Math.max(1, Math.floor(account.config.timeoutSeconds))
      : undefined;
  return fetchImpl || timeoutSeconds
    ? {
        ...(fetchImpl ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] } : {}),
        ...(timeoutSeconds ? { timeoutSeconds } : {}),
      }
    : undefined;
}

function resolveToken(explicit: string | undefined, params: { accountId: string; token: string }) {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.token) {
    throw new Error(
      `Telegram bot token missing for account "${params.accountId}" (set channels.telegram.accounts.${params.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }
  return params.token.trim();
}

function normalizeChatId(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Telegram sends");
  }

  // Common internal prefixes that sometimes leak into outbound sends.
  // - ctx.To uses `telegram:<id>`
  // - group sessions often use `telegram:group:<id>`
  let normalized = stripTelegramInternalPrefixes(trimmed);

  // Accept t.me links for public chats/channels.
  // (Invite links like `t.me/+...` are not resolvable via Bot API.)
  const m =
    /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized) ??
    /^t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized);
  if (m?.[1]) {
    normalized = `@${m[1]}`;
  }

  if (!normalized) {
    throw new Error("Recipient is required for Telegram sends");
  }
  if (normalized.startsWith("@")) {
    return normalized;
  }
  if (/^-?\d+$/.test(normalized)) {
    return normalized;
  }

  // If the user passed a username without `@`, assume they meant a public chat/channel.
  if (/^[A-Za-z0-9_]{5,}$/i.test(normalized)) {
    return `@${normalized}`;
  }

  return normalized;
}

function normalizeMessageId(raw: string | number): number {
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

function isTelegramThreadNotFoundError(err: unknown): boolean {
  return THREAD_NOT_FOUND_RE.test(formatErrorMessage(err));
}

function isTelegramMessageNotModifiedError(err: unknown): boolean {
  return MESSAGE_NOT_MODIFIED_RE.test(formatErrorMessage(err));
}

function hasMessageThreadIdParam(params?: Record<string, unknown>): boolean {
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

function removeMessageThreadIdParam(
  params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!params || !hasMessageThreadIdParam(params)) {
    return params;
  }
  const next = { ...params };
  delete next.message_thread_id;
  return Object.keys(next).length > 0 ? next : undefined;
}

function isTelegramHtmlParseError(err: unknown): boolean {
  return PARSE_ERR_RE.test(formatErrorMessage(err));
}

function buildTelegramThreadReplyParams(params: {
  targetMessageThreadId?: number;
  messageThreadId?: number;
  chatType?: "direct" | "group" | "unknown";
  replyToMessageId?: number;
  quoteText?: string;
}): Record<string, unknown> {
  const messageThreadId =
    params.messageThreadId != null ? params.messageThreadId : params.targetMessageThreadId;
  const threadScope = params.chatType === "direct" ? ("dm" as const) : ("forum" as const);
  // Never blanket-strip DM message_thread_id by chat-id sign.
  // Telegram supports DM topics; stripping silently misroutes topic replies.
  // Keep thread id and rely on thread-not-found retry fallback for plain DMs.
  const threadSpec =
    messageThreadId != null ? { id: messageThreadId, scope: threadScope } : undefined;
  const threadIdParams = buildTelegramThreadParams(threadSpec);
  const threadParams: Record<string, unknown> = threadIdParams ? { ...threadIdParams } : {};

  if (params.replyToMessageId != null) {
    const replyToMessageId = Math.trunc(params.replyToMessageId);
    if (params.quoteText?.trim()) {
      threadParams.reply_parameters = {
        message_id: replyToMessageId,
        quote: params.quoteText.trim(),
      };
    } else {
      threadParams.reply_to_message_id = replyToMessageId;
    }
  }
  return threadParams;
}

async function withTelegramHtmlParseFallback<T>(params: {
  label: string;
  verbose?: boolean;
  requestHtml: (label: string) => Promise<T>;
  requestPlain: (label: string) => Promise<T>;
}): Promise<T> {
  try {
    return await params.requestHtml(params.label);
  } catch (err) {
    if (!isTelegramHtmlParseError(err)) {
      throw err;
    }
    if (params.verbose) {
      sendLogger.warn(
        `telegram ${params.label} failed with HTML parse error, retrying as plain text: ${formatErrorMessage(
          err,
        )}`,
      );
    }
    return await params.requestPlain(`${params.label}-plain`);
  }
}

type TelegramApiContext = {
  cfg: ReturnType<typeof loadConfig>;
  account: ResolvedTelegramAccount;
  api: TelegramApi;
};

function resolveTelegramApiContext(opts: {
  token?: string;
  accountId?: string;
  api?: TelegramApiOverride;
  cfg?: ReturnType<typeof loadConfig>;
}): TelegramApiContext {
  const cfg = opts.cfg ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const client = resolveTelegramClientOptions(account);
  const api = (opts.api ?? new Bot(token, client ? { client } : undefined).api) as TelegramApi;
  return { cfg, account, api };
}

type TelegramRequestWithDiag = <T>(
  fn: () => Promise<T>,
  label?: string,
  options?: { shouldLog?: (err: unknown) => boolean },
) => Promise<T>;

function createTelegramRequestWithDiag(params: {
  cfg: ReturnType<typeof loadConfig>;
  account: ResolvedTelegramAccount;
  retry?: RetryConfig;
  verbose?: boolean;
  shouldRetry?: (err: unknown) => boolean;
  useApiErrorLogging?: boolean;
}): TelegramRequestWithDiag {
  const request = createTelegramRetryRunner({
    retry: params.retry,
    configRetry: params.account.config.retry,
    verbose: params.verbose,
    ...(params.shouldRetry ? { shouldRetry: params.shouldRetry } : {}),
  });
  const logHttpError = createTelegramHttpLogger(params.cfg);
  return <T>(
    fn: () => Promise<T>,
    label?: string,
    options?: { shouldLog?: (err: unknown) => boolean },
  ) => {
    const runRequest = () => request(fn, label);
    const call =
      params.useApiErrorLogging === false
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

function wrapTelegramChatNotFoundError(err: unknown, params: { chatId: string; input: string }) {
  if (!CHAT_NOT_FOUND_RE.test(formatErrorMessage(err))) {
    return err;
  }
  return new Error(
    [
      `Telegram send failed: chat not found (chat_id=${params.chatId}).`,
      "Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
      `Input was: ${JSON.stringify(params.input)}.`,
    ].join(" "),
  );
}

async function withTelegramThreadFallback<T>(
  params: Record<string, unknown> | undefined,
  label: string,
  verbose: boolean | undefined,
  attempt: (
    effectiveParams: Record<string, unknown> | undefined,
    effectiveLabel: string,
  ) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(params, label);
  } catch (err) {
    // Do not widen this fallback to cover "chat not found".
    // chat-not-found is routing/auth/membership/token; stripping thread IDs hides root cause.
    if (!hasMessageThreadIdParam(params) || !isTelegramThreadNotFoundError(err)) {
      throw err;
    }
    if (verbose) {
      sendLogger.warn(
        `telegram ${label} failed with message_thread_id, retrying without thread: ${formatErrorMessage(err)}`,
      );
    }
    const retriedParams = removeMessageThreadIdParam(params);
    return await attempt(retriedParams, `${label}-threadless`);
  }
}

function createRequestWithChatNotFound(params: {
  requestWithDiag: TelegramRequestWithDiag;
  chatId: string;
  input: string;
}) {
  return async <T>(fn: () => Promise<T>, label: string) =>
    params.requestWithDiag(fn, label).catch((err) => {
      throw wrapTelegramChatNotFoundError(err, {
        chatId: params.chatId,
        input: params.input,
      });
    });
}

export function buildInlineKeyboard(
  buttons?: TelegramSendOpts["buttons"],
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) {
    return undefined;
  }
  const rows = buttons
    .map((row) =>
      row
        .filter((button) => button?.text && button?.callback_data)
        .map(
          (button): InlineKeyboardButton => ({
            text: button.text,
            callback_data: button.callback_data,
            ...(button.style ? { style: button.style } : {}),
          }),
        ),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return undefined;
  }
  return { inline_keyboard: rows };
}

export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts = {},
): Promise<TelegramSendResult> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const target = parseTelegramTarget(to);
  const chatId = normalizeChatId(target.chatId);
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
  const renderHtmlText = (value: string) => renderTelegramHtmlText(value, { textMode, tableMode });

  // Resolve link preview setting from config (default: enabled).
  const linkPreviewEnabled = account.config.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };

  const sendTelegramText = async (
    rawText: string,
    params?: Record<string, unknown>,
    fallbackText?: string,
  ) => {
    return await withTelegramThreadFallback(
      params,
      "message",
      opts.verbose,
      async (effectiveParams, label) => {
        const htmlText = renderHtmlText(rawText);
        const baseParams = effectiveParams ? { ...effectiveParams } : {};
        if (linkPreviewOptions) {
          baseParams.link_preview_options = linkPreviewOptions;
        }
        const hasBaseParams = Object.keys(baseParams).length > 0;
        const sendParams = {
          parse_mode: "HTML" as const,
          ...baseParams,
          ...(opts.silent === true ? { disable_notification: true } : {}),
        };
        return await withTelegramHtmlParseFallback({
          label,
          verbose: opts.verbose,
          requestHtml: (retryLabel) =>
            requestWithChatNotFound(
              () =>
                api.sendMessage(
                  chatId,
                  htmlText,
                  sendParams as Parameters<typeof api.sendMessage>[2],
                ),
              retryLabel,
            ),
          requestPlain: (retryLabel) => {
            const plainParams = hasBaseParams
              ? (baseParams as Parameters<typeof api.sendMessage>[2])
              : undefined;
            return requestWithChatNotFound(
              () =>
                plainParams
                  ? api.sendMessage(chatId, fallbackText ?? rawText, plainParams)
                  : api.sendMessage(chatId, fallbackText ?? rawText),
              retryLabel,
            );
          },
        });
      },
    );
  };

  if (mediaUrl) {
    const media = await loadWebMedia(mediaUrl, {
      maxBytes: opts.maxBytes,
      localRoots: opts.mediaLocalRoots,
    });
    const kind = mediaKindFromMime(media.contentType ?? undefined);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });
    const isVideoNote = kind === "video" && opts.asVideoNote === true;
    const fileName = media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind)) ?? "file";
    const file = new InputFile(media.buffer, fileName);
    let caption: string | undefined;
    let followUpText: string | undefined;

    if (isVideoNote) {
      caption = undefined;
      followUpText = text.trim() ? text : undefined;
    } else {
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
      ...(htmlCaption ? { caption: htmlCaption, parse_mode: "HTML" as const } : {}),
      ...baseMediaParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
    };
    const sendMedia = async (
      label: string,
      sender: (
        effectiveParams: Record<string, unknown> | undefined,
      ) => Promise<TelegramMessageLike>,
    ) =>
      await withTelegramThreadFallback(
        mediaParams,
        label,
        opts.verbose,
        async (effectiveParams, retryLabel) =>
          requestWithChatNotFound(() => sender(effectiveParams), retryLabel),
      );

    const mediaSender = (() => {
      if (isGif) {
        return {
          label: "animation",
          sender: (effectiveParams: Record<string, unknown> | undefined) =>
            api.sendAnimation(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendAnimation>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      if (kind === "image") {
        return {
          label: "photo",
          sender: (effectiveParams: Record<string, unknown> | undefined) =>
            api.sendPhoto(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendPhoto>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      if (kind === "video") {
        if (isVideoNote) {
          return {
            label: "video_note",
            sender: (effectiveParams: Record<string, unknown> | undefined) =>
              api.sendVideoNote(
                chatId,
                file,
                effectiveParams as Parameters<typeof api.sendVideoNote>[2],
              ) as Promise<TelegramMessageLike>,
          };
        }
        return {
          label: "video",
          sender: (effectiveParams: Record<string, unknown> | undefined) =>
            api.sendVideo(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendVideo>[2],
            ) as Promise<TelegramMessageLike>,
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
            sender: (effectiveParams: Record<string, unknown> | undefined) =>
              api.sendVoice(
                chatId,
                file,
                effectiveParams as Parameters<typeof api.sendVoice>[2],
              ) as Promise<TelegramMessageLike>,
          };
        }
        return {
          label: "audio",
          sender: (effectiveParams: Record<string, unknown> | undefined) =>
            api.sendAudio(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendAudio>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      return {
        label: "document",
        sender: (effectiveParams: Record<string, unknown> | undefined) =>
          api.sendDocument(
            chatId,
            file,
            effectiveParams as Parameters<typeof api.sendDocument>[2],
          ) as Promise<TelegramMessageLike>,
      };
    })();

    const result = await sendMedia(mediaSender.label, mediaSender.sender);
    const mediaMessageId = String(result?.message_id ?? "unknown");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    if (result?.message_id) {
      recordSentMessage(chatId, result.message_id);
    }
    recordChannelActivity({
      channel: "telegram",
      accountId: account.accountId,
      direction: "outbound",
    });

    // If text was too long for a caption, send it as a separate follow-up message.
    // Use HTML conversion so markdown renders like captions.
    if (needsSeparateText && followUpText) {
      const textParams =
        hasThreadParams || replyMarkup
          ? {
              ...threadParams,
              ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }
          : undefined;
      const textRes = await sendTelegramText(followUpText, textParams);
      // Return the text message ID as the "main" message (it's the actual content).
      return {
        messageId: String(textRes?.message_id ?? mediaMessageId),
        chatId: resolvedChatId,
      };
    }

    return { messageId: mediaMessageId, chatId: resolvedChatId };
  }

  if (!text || !text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  const textParams =
    hasThreadParams || replyMarkup
      ? {
          ...threadParams,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : undefined;
  const res = await sendTelegramText(text, textParams, opts.plainText);
  const messageId = String(res?.message_id ?? "unknown");
  if (res?.message_id) {
    recordSentMessage(chatId, res.message_id);
  }
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });
  return { messageId, chatId: String(res?.chat?.id ?? chatId) };
}

export async function reactMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  emoji: string,
  opts: TelegramReactionOpts = {},
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const chatId = normalizeChatId(String(chatIdInput));
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
  const reactions: ReactionType[] =
    remove || !trimmedEmoji
      ? []
      : [{ type: "emoji", emoji: trimmedEmoji as ReactionTypeEmoji["emoji"] }];
  if (typeof api.setMessageReaction !== "function") {
    throw new Error("Telegram reactions are unavailable in this bot API.");
  }
  try {
    await requestWithDiag(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/REACTION_INVALID/i.test(msg)) {
      return { ok: false as const, warning: `Reaction unavailable: ${trimmedEmoji}` };
    }
    throw err;
  }
  return { ok: true };
}

type TelegramDeleteOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
};

export async function deleteMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramDeleteOpts = {},
): Promise<{ ok: true }> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const chatId = normalizeChatId(String(chatIdInput));
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

type TelegramEditOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  /** Controls whether link previews are shown in the edited message. */
  linkPreview?: boolean;
  /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: TelegramInlineButtons;
  /** Optional config injection to avoid global loadConfig() (improves testability). */
  cfg?: ReturnType<typeof loadConfig>;
};

export async function editMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  text: string,
  opts: TelegramEditOpts = {},
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { cfg, account, api } = resolveTelegramApiContext({
    ...opts,
    cfg: opts.cfg,
  });
  const chatId = normalizeChatId(String(chatIdInput));
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  const requestWithEditShouldLog = <T>(
    fn: () => Promise<T>,
    label?: string,
    shouldLog?: (err: unknown) => boolean,
  ) => requestWithDiag(fn, label, shouldLog ? { shouldLog } : undefined);

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

  const editParams: Record<string, unknown> = {
    parse_mode: "HTML",
  };
  if (opts.linkPreview === false) {
    editParams.link_preview_options = { is_disabled: true };
  }
  if (replyMarkup !== undefined) {
    editParams.reply_markup = replyMarkup;
  }
  const plainParams: Record<string, unknown> = {};
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
      requestHtml: (retryLabel) =>
        requestWithEditShouldLog(
          () => api.editMessageText(chatId, messageId, htmlText, editParams),
          retryLabel,
          (err) => !isTelegramMessageNotModifiedError(err),
        ),
      requestPlain: (retryLabel) =>
        requestWithEditShouldLog(
          () =>
            Object.keys(plainParams).length > 0
              ? api.editMessageText(chatId, messageId, text, plainParams)
              : api.editMessageText(chatId, messageId, text),
          retryLabel,
          (plainErr) => !isTelegramMessageNotModifiedError(plainErr),
        ),
    });
  } catch (err) {
    if (isTelegramMessageNotModifiedError(err)) {
      // no-op: Telegram reports message content unchanged, treat as success
    } else {
      throw err;
    }
  }

  logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
}

function inferFilename(kind: ReturnType<typeof mediaKindFromMime>) {
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

type TelegramStickerOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
};

/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export async function sendStickerTelegram(
  to: string,
  fileId: string,
  opts: TelegramStickerOpts = {},
): Promise<TelegramSendResult> {
  if (!fileId?.trim()) {
    throw new Error("Telegram sticker file_id is required");
  }

  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const target = parseTelegramTarget(to);
  const chatId = normalizeChatId(target.chatId);

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

  const result = await withTelegramThreadFallback(
    stickerParams,
    "sticker",
    opts.verbose,
    async (effectiveParams, label) =>
      requestWithChatNotFound(() => api.sendSticker(chatId, fileId.trim(), effectiveParams), label),
  );

  const messageId = String(result?.message_id ?? "unknown");
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  if (result?.message_id) {
    recordSentMessage(chatId, result.message_id);
  }
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId, chatId: resolvedChatId };
}

type TelegramPollOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
  /** Whether votes are anonymous. Defaults to true (Telegram default). */
  isAnonymous?: boolean;
};

/**
 * Send a poll to a Telegram chat.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param poll - Poll input with question, options, maxSelections, and optional durationHours
 * @param opts - Optional configuration
 */
export async function sendPollTelegram(
  to: string,
  poll: PollInput,
  opts: TelegramPollOpts = {},
): Promise<{ messageId: string; chatId: string; pollId?: string }> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const target = parseTelegramTarget(to);
  const chatId = normalizeChatId(target.chatId);

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
    throw new Error(
      "Telegram poll durationHours is not supported. Use durationSeconds (5-600) instead.",
    );
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

  const result = await withTelegramThreadFallback(
    pollParams,
    "poll",
    opts.verbose,
    async (effectiveParams, label) =>
      requestWithChatNotFound(
        () => api.sendPoll(chatId, normalizedPoll.question, pollOptions, effectiveParams),
        label,
      ),
  );

  const messageId = String(result?.message_id ?? "unknown");
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  const pollId = result?.poll?.id;
  if (result?.message_id) {
    recordSentMessage(chatId, result.message_id);
  }

  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId, chatId: resolvedChatId, pollId };
}

// ---------------------------------------------------------------------------
// Forum topic creation
// ---------------------------------------------------------------------------

type TelegramCreateForumTopicOpts = {
  token?: string;
  accountId?: string;
  api?: Bot["api"];
  verbose?: boolean;
  retry?: RetryConfig;
  /** Icon color for the topic (must be one of 0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F). */
  iconColor?: number;
  /** Custom emoji ID for the topic icon. */
  iconCustomEmojiId?: string;
};

export type TelegramCreateForumTopicResult = {
  topicId: number;
  name: string;
  chatId: string;
};

/**
 * Create a forum topic in a Telegram supergroup.
 * Requires the bot to have `can_manage_topics` permission.
 *
 * @param chatId - Supergroup chat ID
 * @param name - Topic name (1-128 characters)
 * @param opts - Optional configuration
 */
export async function createForumTopicTelegram(
  chatId: string,
  name: string,
  opts: TelegramCreateForumTopicOpts = {},
): Promise<TelegramCreateForumTopicResult> {
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
  const target = parseTelegramTarget(chatId);
  const normalizedChatId = normalizeChatId(target.chatId);
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;

  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      fn: () => request(fn, label),
    }).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });

  const extra: Record<string, unknown> = {};
  if (opts.iconColor != null) {
    extra.icon_color = opts.iconColor;
  }
  if (opts.iconCustomEmojiId?.trim()) {
    extra.icon_custom_emoji_id = opts.iconCustomEmojiId.trim();
  }

  const hasExtra = Object.keys(extra).length > 0;
  const result = await requestWithDiag(
    () => api.createForumTopic(normalizedChatId, trimmedName, hasExtra ? extra : undefined),
    "createForumTopic",
  );

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
