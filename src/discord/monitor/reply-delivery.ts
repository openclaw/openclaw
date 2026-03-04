import type { RequestClient } from "@buape/carbon";
import { resolveAgentAvatar } from "../../agents/identity-avatar.js";
import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { loadConfig } from "../../config/config.js";
import type { MarkdownTableMode, ReplyToMode } from "../../config/types.base.js";
import { createDiscordRetryRunner, type RetryRunner } from "../../infra/retry-policy.js";
import { resolveRetryConfig, retryAsync, type RetryConfig } from "../../infra/retry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveDiscordAccount } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { sendMessageDiscord, sendVoiceMessageDiscord, sendWebhookMessageDiscord } from "../send.js";
import { sendDiscordText } from "../send.shared.js";

const log = createSubsystemLogger("discord/delivery");

export type DiscordThreadBindingLookupRecord = {
  accountId: string;
  threadId: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
};

export type DiscordThreadBindingLookup = {
  listBySessionKey: (targetSessionKey: string) => DiscordThreadBindingLookupRecord[];
  touchThread?: (params: { threadId: string; at?: number; persist?: boolean }) => unknown;
};

type ResolvedRetryConfig = Required<RetryConfig>;

const DISCORD_DELIVERY_RETRY_DEFAULTS: ResolvedRetryConfig = {
  attempts: 3,
  minDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0,
};

function extractHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (typeof status === "number" && Number.isFinite(status)) {
    return status;
  }
  // sendWebhookMessageDiscord throws plain Error with status in message,
  // e.g. "Discord webhook send failed (429: ...)". Extract as fallback.
  const message = (err as { message?: string }).message;
  if (typeof message === "string") {
    const match = message.match(/(?:\((\d{3})\b|\b(\d{3})\s)/);
    if (match) {
      return Number(match[1] ?? match[2]);
    }
  }
  return undefined;
}

function isRetryableDiscordError(err: unknown): boolean {
  const status = extractHttpStatus(err);
  return status === 429 || (status !== undefined && status >= 500);
}

function getDiscordRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  if (
    "retryAfter" in err &&
    typeof err.retryAfter === "number" &&
    Number.isFinite(err.retryAfter)
  ) {
    return err.retryAfter * 1000;
  }
  const retryAfterRaw = (err as { headers?: Record<string, string> }).headers?.["retry-after"];
  if (!retryAfterRaw) {
    return undefined;
  }
  const retryAfterMs = Number(retryAfterRaw) * 1000;
  return Number.isFinite(retryAfterMs) ? retryAfterMs : undefined;
}

function resolveDeliveryRetryConfig(retry?: RetryConfig): ResolvedRetryConfig {
  return resolveRetryConfig(DISCORD_DELIVERY_RETRY_DEFAULTS, retry);
}

async function sendWithRetry(
  fn: () => Promise<unknown>,
  retryConfig: ResolvedRetryConfig,
): Promise<void> {
  await retryAsync(fn, {
    ...retryConfig,
    shouldRetry: (err) => isRetryableDiscordError(err),
    retryAfterMs: getDiscordRetryAfterMs,
    onRetry: (info) => {
      const status = extractHttpStatus(info.err);
      log.warn(
        `discord delivery retry ${info.attempt}/${info.maxAttempts} after HTTP ${status ?? "??"} (delay ${info.delayMs}ms)`,
      );
    },
  });
}

function resolveTargetChannelId(target: string): string | undefined {
  if (!target.startsWith("channel:")) {
    return undefined;
  }
  const channelId = target.slice("channel:".length).trim();
  return channelId || undefined;
}

function resolveBoundThreadBinding(params: {
  threadBindings?: DiscordThreadBindingLookup;
  sessionKey?: string;
  target: string;
}): DiscordThreadBindingLookupRecord | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!params.threadBindings || !sessionKey) {
    return undefined;
  }
  const bindings = params.threadBindings.listBySessionKey(sessionKey);
  if (bindings.length === 0) {
    return undefined;
  }
  const targetChannelId = resolveTargetChannelId(params.target);
  if (!targetChannelId) {
    return undefined;
  }
  return bindings.find((entry) => entry.threadId === targetChannelId);
}

function resolveBindingPersona(binding: DiscordThreadBindingLookupRecord | undefined): {
  username?: string;
  avatarUrl?: string;
} {
  if (!binding) {
    return {};
  }
  const baseLabel = binding.label?.trim() || binding.agentId;
  const username = (`🤖 ${baseLabel}`.trim() || "🤖 agent").slice(0, 80);

  let avatarUrl: string | undefined;
  try {
    const avatar = resolveAgentAvatar(loadConfig(), binding.agentId);
    if (avatar.kind === "remote") {
      avatarUrl = avatar.url;
    }
  } catch {
    avatarUrl = undefined;
  }
  return { username, avatarUrl };
}

async function sendDiscordChunkWithFallback(params: {
  target: string;
  text: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  replyTo?: string;
  binding?: DiscordThreadBindingLookupRecord;
  username?: string;
  avatarUrl?: string;
  /** Pre-resolved channel ID to bypass redundant resolution per chunk. */
  channelId?: string;
  /** Pre-created retry runner to avoid creating one per chunk. */
  request?: RetryRunner;
  /** Pre-resolved retry config (account-level). */
  retryConfig: ResolvedRetryConfig;
}) {
  if (!params.text.trim()) {
    return;
  }
  const text = params.text;
  const binding = params.binding;
  const webhookId = binding?.webhookId;
  const webhookToken = binding?.webhookToken;
  if (webhookId && webhookToken && binding) {
    try {
      await sendWithRetry(
        () =>
          sendWebhookMessageDiscord(text, {
            webhookId,
            webhookToken,
            accountId: binding.accountId,
            threadId: binding.threadId,
            replyTo: params.replyTo,
            username: params.username,
            avatarUrl: params.avatarUrl,
          }),
        params.retryConfig,
      );
      return;
    } catch (err) {
      // Only fall through to bot sender for non-retryable errors.
      // Retryable errors (429/5xx) were already retried and exhausted.
      if (isRetryableDiscordError(err)) {
        throw err;
      }
      // Fall through to the standard bot sender path.
    }
  }
  // When channelId and request are pre-resolved, send directly via sendDiscordText
  // to avoid per-chunk overhead (channel-type GET, re-chunking, client creation)
  // that can cause ordering issues under queue contention or rate limiting.
  if (params.channelId && params.request && params.rest) {
    const { channelId, request, rest } = params;
    await sendWithRetry(
      () => sendDiscordText(rest, channelId, text, params.replyTo, request),
      params.retryConfig,
    );
    return;
  }
  await sendWithRetry(
    () =>
      sendMessageDiscord(params.target, text, {
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo: params.replyTo,
      }),
    params.retryConfig,
  );
}

async function sendAdditionalDiscordMedia(params: {
  target: string;
  token: string;
  rest?: RequestClient;
  accountId?: string;
  mediaUrls: string[];
  mediaLocalRoots?: readonly string[];
  resolveReplyTo: () => string | undefined;
  retryConfig: ResolvedRetryConfig;
}) {
  for (const mediaUrl of params.mediaUrls) {
    const replyTo = params.resolveReplyTo();
    await sendWithRetry(
      () =>
        sendMessageDiscord(params.target, "", {
          token: params.token,
          rest: params.rest,
          mediaUrl,
          accountId: params.accountId,
          mediaLocalRoots: params.mediaLocalRoots,
          replyTo,
        }),
      params.retryConfig,
    );
  }
}

export async function deliverDiscordReply(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToId?: string;
  replyToMode?: ReplyToMode;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  sessionKey?: string;
  threadBindings?: DiscordThreadBindingLookup;
  mediaLocalRoots?: readonly string[];
}) {
  const chunkLimit = Math.min(params.textLimit, 2000);
  const replyTo = params.replyToId?.trim() || undefined;
  const replyToMode = params.replyToMode ?? "all";
  // replyToMode=first should only apply to the first physical send.
  const replyOnce = replyToMode === "first";
  let replyUsed = false;
  const resolveReplyTo = () => {
    if (!replyTo) {
      return undefined;
    }
    if (!replyOnce) {
      return replyTo;
    }
    if (replyUsed) {
      return undefined;
    }
    replyUsed = true;
    return replyTo;
  };
  const binding = resolveBoundThreadBinding({
    threadBindings: params.threadBindings,
    sessionKey: params.sessionKey,
    target: params.target,
  });
  const persona = resolveBindingPersona(binding);
  // Pre-resolve channel ID and retry runner once to avoid per-chunk overhead.
  // This eliminates redundant channel-type GET requests and client creation that
  // can cause ordering issues when multiple chunks share the RequestClient queue.
  const channelId = resolveTargetChannelId(params.target);
  const account = resolveDiscordAccount({ cfg: loadConfig(), accountId: params.accountId });
  const retryConfig = resolveDeliveryRetryConfig(account.config.retry);
  const request: RetryRunner | undefined = channelId
    ? createDiscordRetryRunner({ configRetry: account.config.retry })
    : undefined;
  let deliveredAny = false;
  for (const payload of params.replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = payload.text ?? "";
    const tableMode = params.tableMode ?? "code";
    const text = convertMarkdownTables(rawText, tableMode);
    if (!text && mediaList.length === 0) {
      continue;
    }
    if (mediaList.length === 0) {
      const mode = params.chunkMode ?? "length";
      const chunks = chunkDiscordTextWithMode(text, {
        maxChars: chunkLimit,
        maxLines: params.maxLinesPerMessage,
        chunkMode: mode,
      });
      if (!chunks.length && text) {
        chunks.push(text);
      }
      for (const chunk of chunks) {
        if (!chunk.trim()) {
          continue;
        }
        const replyTo = resolveReplyTo();
        await sendDiscordChunkWithFallback({
          target: params.target,
          text: chunk,
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
          replyTo,
          binding,
          username: persona.username,
          avatarUrl: persona.avatarUrl,
          channelId,
          request,
          retryConfig,
        });
        deliveredAny = true;
      }
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) {
      continue;
    }

    // Voice message path: audioAsVoice flag routes through sendVoiceMessageDiscord.
    if (payload.audioAsVoice) {
      const replyTo = resolveReplyTo();
      await sendWithRetry(
        () =>
          sendVoiceMessageDiscord(params.target, firstMedia, {
            token: params.token,
            rest: params.rest,
            accountId: params.accountId,
            replyTo,
          }),
        retryConfig,
      );
      deliveredAny = true;
      // Voice messages cannot include text; send remaining text separately if present.
      await sendDiscordChunkWithFallback({
        target: params.target,
        text,
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo: resolveReplyTo(),
        binding,
        username: persona.username,
        avatarUrl: persona.avatarUrl,
        channelId,
        request,
        retryConfig,
      });
      // Additional media items are sent as regular attachments (voice is single-file only).
      await sendAdditionalDiscordMedia({
        target: params.target,
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        mediaUrls: mediaList.slice(1),
        mediaLocalRoots: params.mediaLocalRoots,
        resolveReplyTo,
        retryConfig,
      });
      continue;
    }

    const replyTo = resolveReplyTo();
    await sendWithRetry(
      () =>
        sendMessageDiscord(params.target, text, {
          token: params.token,
          rest: params.rest,
          mediaUrl: firstMedia,
          accountId: params.accountId,
          mediaLocalRoots: params.mediaLocalRoots,
          replyTo,
        }),
      retryConfig,
    );
    deliveredAny = true;
    await sendAdditionalDiscordMedia({
      target: params.target,
      token: params.token,
      rest: params.rest,
      accountId: params.accountId,
      mediaUrls: mediaList.slice(1),
      mediaLocalRoots: params.mediaLocalRoots,
      resolveReplyTo,
      retryConfig,
    });
  }

  if (binding && deliveredAny) {
    params.threadBindings?.touchThread?.({ threadId: binding.threadId });
  }
}
