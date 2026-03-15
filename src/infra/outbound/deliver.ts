import {
  markdownToSignalTextChunks,
  type SignalTextStyleRange,
} from "../../../extensions/signal/src/format.js";
import {
  isSignalGroupTarget,
  resolveSignalQuoteMetadata,
} from "../../../extensions/signal/src/reply-quote.js";
import { sendMessageSignal } from "../../../extensions/signal/src/send.js";
import {
  chunkByParagraph,
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveChannelMediaMaxBytes } from "../../channels/plugins/media-limits.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import {
  appendAssistantMessageToSessionTranscript,
  resolveMirroredTranscriptText,
} from "../../config/sessions.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../../hooks/message-hook-mappers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { throwIfAborted } from "./abort.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "./delivery-queue.js";
import type { OutboundIdentity } from "./identity.js";
import type { DeliveryMirror } from "./mirror.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import { normalizeReplyPayloadsForDelivery } from "./payloads.js";
import { readReplyApplied } from "./reply-applied.js";
import { isPlainTextSurface, sanitizeForPlainText } from "./sanitize-text.js";
import { resolveOutboundSendDep, type OutboundSendDeps } from "./send-deps.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";
export { resolveOutboundSendDep, type OutboundSendDeps } from "./send-deps.js";

const log = createSubsystemLogger("outbound/deliver");
const TELEGRAM_TEXT_LIMIT = 4096;

export type OutboundDeliveryResult = {
  channel: Exclude<OutboundChannel, "none">;
  messageId: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  pollId?: string;
  // Channel docking: stash channel-specific fields here to avoid core type churn.
  meta?: Record<string, unknown>;
};

type Chunker = (text: string, limit: number) => string[];

type ChannelHandler = {
  chunker: Chunker | null;
  chunkerMode?: "text" | "markdown";
  textChunkLimit?: number;
  supportsMedia: boolean;
  sendPayload?: (
    payload: ReplyPayload,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendText: (
    text: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendMedia: (
    caption: string,
    mediaUrl: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
    },
  ) => Promise<OutboundDeliveryResult>;
};

type ChannelHandlerParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  quoteAuthor?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mediaLocalRoots?: readonly string[];
};

// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function createChannelHandler(params: ChannelHandlerParams): Promise<ChannelHandler> {
  const outbound = await loadChannelOutboundAdapter(params.channel);
  const handler = createPluginHandler({ ...params, outbound });
  if (!handler) {
    throw new Error(`Outbound not configured for channel: ${params.channel}`);
  }
  return handler;
}

function createPluginHandler(
  params: ChannelHandlerParams & { outbound?: ChannelOutboundAdapter },
): ChannelHandler | null {
  const outbound = params.outbound;
  if (!outbound?.sendText) {
    return null;
  }
  const baseCtx = createChannelOutboundContextBase(params);
  const sendText = outbound.sendText;
  const sendMedia = outbound.sendMedia;
  const chunker = outbound.chunker ?? null;
  const chunkerMode = outbound.chunkerMode;
  const resolveCtx = (overrides?: {
    replyToId?: string | null;
    threadId?: string | number | null;
  }): Omit<ChannelOutboundContext, "text" | "mediaUrl"> => ({
    ...baseCtx,
    // Preserve explicit null overrides so later payloads can suppress inherited reply/thread metadata.
    replyToId: overrides && "replyToId" in overrides ? overrides.replyToId : baseCtx.replyToId,
    threadId: overrides && "threadId" in overrides ? overrides.threadId : baseCtx.threadId,
  });
  return {
    chunker,
    chunkerMode,
    textChunkLimit: outbound.textChunkLimit,
    supportsMedia: Boolean(sendMedia),
    sendPayload: outbound.sendPayload
      ? async (payload, overrides) =>
          outbound.sendPayload!({
            ...resolveCtx(overrides),
            text: payload.text ?? "",
            mediaUrl: payload.mediaUrl,
            payload,
          })
      : undefined,
    sendText: async (text, overrides) =>
      sendText({
        ...resolveCtx(overrides),
        text,
      }),
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
        mediaUrl,
      });
    },
  };
}

function createChannelOutboundContextBase(
  params: ChannelHandlerParams,
): Omit<ChannelOutboundContext, "text" | "mediaUrl"> {
  return {
    cfg: params.cfg,
    to: params.to,
    accountId: params.accountId,
    replyToId: params.replyToId,
    quoteAuthor: params.quoteAuthor,
    threadId: params.threadId,
    identity: params.identity,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    deps: params.deps,
    silent: params.silent,
    mediaLocalRoots: params.mediaLocalRoots,
  };
}

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

type DeliverOutboundPayloadsCoreParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  quoteAuthor?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  /** Session/agent context used for hooks and media local-root scoping. */
  session?: OutboundSessionContext;
  mirror?: DeliveryMirror;
  silent?: boolean;
};

export type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
  /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
  skipQueue?: boolean;
};

type MessageSentEvent = {
  success: boolean;
  content: string;
  error?: string;
  messageId?: string;
};

function hasMediaPayload(payload: ReplyPayload): boolean {
  return Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
}

function hasChannelDataPayload(payload: ReplyPayload): boolean {
  return Boolean(payload.channelData && Object.keys(payload.channelData).length > 0);
}

function normalizePayloadForChannelDelivery(
  payload: ReplyPayload,
  channelId: string,
): ReplyPayload | null {
  const hasMedia = hasMediaPayload(payload);
  const hasChannelData = hasChannelDataPayload(payload);
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const normalizedText =
    channelId === "whatsapp" ? rawText.replace(/^(?:[ \t]*\r?\n)+/, "") : rawText;
  if (!normalizedText.trim()) {
    if (!hasMedia && !hasChannelData) {
      return null;
    }
    return {
      ...payload,
      text: "",
    };
  }
  if (normalizedText === rawText) {
    return payload;
  }
  return {
    ...payload,
    text: normalizedText,
  };
}

function normalizePayloadsForChannelDelivery(
  payloads: ReplyPayload[],
  channel: Exclude<OutboundChannel, "none">,
  _cfg: OpenClawConfig,
  _to: string,
  _accountId?: string,
): ReplyPayload[] {
  const normalizedPayloads: ReplyPayload[] = [];
  for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
    let sanitizedPayload = payload;
    // Strip HTML tags for plain-text surfaces (WhatsApp, Signal, etc.)
    // Models occasionally produce <br>, <b>, etc. that render as literal text.
    // See https://github.com/openclaw/openclaw/issues/31884
    if (isPlainTextSurface(channel) && sanitizedPayload.text) {
      // Telegram sendPayload uses textMode:"html". Preserve raw HTML in this path.
      if (!(channel === "telegram" && sanitizedPayload.channelData)) {
        sanitizedPayload = {
          ...sanitizedPayload,
          text: sanitizeForPlainText(sanitizedPayload.text),
        };
      }
    }
    const normalized = normalizePayloadForChannelDelivery(sanitizedPayload, channel);
    if (normalized) {
      normalizedPayloads.push(normalized);
    }
  }
  return normalizedPayloads;
}

function buildPayloadSummary(payload: ReplyPayload): NormalizedOutboundPayload {
  return {
    text: payload.text ?? "",
    mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
    channelData: payload.channelData,
  };
}

function createMessageSentEmitter(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
}): { emitMessageSent: (event: MessageSentEvent) => void; hasMessageSentHooks: boolean } {
  const hasMessageSentHooks = params.hookRunner?.hasHooks("message_sent") ?? false;
  const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
  const emitMessageSent = (event: MessageSentEvent) => {
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
      fireAndForgetHook(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
        "deliverOutboundPayloads: message_sent plugin hook failed",
        (message) => {
          log.warn(message);
        },
      );
    }
    if (!canEmitInternalHook) {
      return;
    }
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "sent",
          params.sessionKeyForInternalHooks!,
          toInternalMessageSentContext(canonical),
        ),
      ),
      "deliverOutboundPayloads: message:sent internal hook failed",
      (message) => {
        log.warn(message);
      },
    );
  };
  return { emitMessageSent, hasMessageSentHooks };
}

async function applyMessageSendingHook(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  enabled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
  to: string;
  channel: Exclude<OutboundChannel, "none">;
  accountId?: string;
}): Promise<{
  cancelled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
}> {
  if (!params.enabled) {
    return {
      cancelled: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
  try {
    const sendingResult = await params.hookRunner!.runMessageSending(
      {
        to: params.to,
        content: params.payloadSummary.text,
        metadata: {
          channel: params.channel,
          accountId: params.accountId,
          mediaUrls: params.payloadSummary.mediaUrls,
        },
      },
      {
        channelId: params.channel,
        accountId: params.accountId ?? undefined,
      },
    );
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
  } catch {
    // Don't block delivery on hook failure.
    return {
      cancelled: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
}

export async function deliverOutboundPayloads(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
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
        forceDocument: params.forceDocument,
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
        onError: (err: unknown, payload: NormalizedOutboundPayload) => {
          hadPartialFailure = true;
          params.onError!(err, payload);
        },
      }
    : params;

  try {
    const results = await deliverOutboundPayloadsCore(wrappedParams);
    if (queueId) {
      if (hadPartialFailure) {
        await failDelivery(queueId, "partial delivery failure (bestEffort)").catch(() => {});
      } else {
        await ackDelivery(queueId).catch(() => {}); // Best-effort cleanup.
      }
    }
    return results;
  } catch (err) {
    if (queueId) {
      if (isAbortError(err)) {
        await ackDelivery(queueId).catch(() => {});
      } else {
        await failDelivery(queueId, err instanceof Error ? err.message : String(err)).catch(
          () => {},
        );
      }
    }
    throw err;
  }
}

/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(
  params: DeliverOutboundPayloadsCoreParams,
): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to, payloads } = params;
  const accountId = params.accountId;
  const deps = params.deps;
  const abortSignal = params.abortSignal;
  const sendSignal =
    resolveOutboundSendDep<typeof sendMessageSignal>(params.deps, "signal") ?? sendMessageSignal;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(
    cfg,
    params.session?.agentId ?? params.mirror?.agentId,
  );
  const results: OutboundDeliveryResult[] = [];
  const handler = await createChannelHandler({
    cfg,
    channel,
    to,
    deps,
    accountId,
    replyToId: params.replyToId,
    quoteAuthor: params.quoteAuthor,
    threadId: params.threadId,
    identity: params.identity,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mediaLocalRoots,
  });
  const configuredTextLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, channel, accountId, {
        fallbackLimit: handler.textChunkLimit,
      })
    : undefined;
  const textLimit =
    channel === "telegram" && typeof configuredTextLimit === "number"
      ? Math.min(configuredTextLimit, TELEGRAM_TEXT_LIMIT)
      : configuredTextLimit;
  const chunkMode = handler.chunker ? resolveChunkMode(cfg, channel, accountId) : "length";
  const isSignalChannel = channel === "signal";
  const signalIsGroupTarget = isSignalChannel && isSignalGroupTarget(to);
  const signalTableMode = isSignalChannel
    ? resolveMarkdownTableMode({ cfg, channel: "signal", accountId })
    : "code";
  const signalMaxBytes = isSignalChannel
    ? resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.signal?.mediaMaxMb,
        accountId,
      })
    : undefined;

  const sendTextChunks = async (
    text: string,
    overrides?: { replyToId?: string | null; threadId?: string | number | null },
  ) => {
    throwIfAborted(abortSignal);
    if (!handler.chunker || textLimit === undefined) {
      results.push(await handler.sendText(text, overrides));
      return;
    }
    if (chunkMode === "newline") {
      const mode = handler.chunkerMode ?? "text";
      const blockChunks =
        mode === "markdown"
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

  const sendSignalText = async (
    text: string,
    styles: SignalTextStyleRange[],
    replyTo?: string,
    quoteAuthor?: string,
  ) => {
    throwIfAborted(abortSignal);
    return {
      channel: "signal" as const,
      ...(await sendSignal(to, text, {
        cfg,
        maxBytes: signalMaxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: styles,
        replyTo,
        quoteAuthor,
      })),
    };
  };

  const sendSignalTextChunks = async (text: string, replyTo?: string, quoteAuthor?: string) => {
    throwIfAborted(abortSignal);
    let signalChunks =
      textLimit === undefined
        ? markdownToSignalTextChunks(text, Number.POSITIVE_INFINITY, {
            tableMode: signalTableMode,
          })
        : markdownToSignalTextChunks(text, textLimit, { tableMode: signalTableMode });
    if (signalChunks.length === 0 && text) {
      signalChunks = [{ text, styles: [] }];
    }
    let first = true;
    for (const chunk of signalChunks) {
      throwIfAborted(abortSignal);
      // Pass replyTo and quoteAuthor only on the FIRST chunk
      results.push(
        await sendSignalText(
          chunk.text,
          chunk.styles,
          first ? replyTo : undefined,
          first ? quoteAuthor : undefined,
        ),
      );
      first = false;
    }
  };

  const sendSignalMedia = async (
    caption: string,
    mediaUrl: string,
    replyTo?: string,
    quoteAuthor?: string,
  ) => {
    throwIfAborted(abortSignal);
    const formatted = markdownToSignalTextChunks(caption, Number.POSITIVE_INFINITY, {
      tableMode: signalTableMode,
    })[0] ?? {
      text: caption,
      styles: [],
    };
    return {
      channel: "signal" as const,
      ...(await sendSignal(to, formatted.text, {
        cfg,
        mediaUrl,
        maxBytes: signalMaxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: formatted.styles,
        mediaLocalRoots,
        replyTo,
        quoteAuthor,
      })),
    };
  };
  const normalizedPayloads = normalizePayloadsForChannelDelivery(
    payloads,
    channel,
    cfg,
    to,
    accountId,
  );
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
  if (hasMessageSentHooks && params.session?.agentId && !sessionKeyForInternalHooks) {
    log.warn(
      "deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped",
      {
        channel,
        to,
        agentId: params.session.agentId,
      },
    );
  }
  let replyConsumed = false;
  // Slack, Mattermost, and Google Chat use replyToId as persistent thread
  // context (thread_ts, rootId, and threadName respectively) that must survive
  // across all payloads. Never consume inherited reply state for thread-based
  // channels.
  const isThreadBasedChannel =
    channel === "slack" || channel === "mattermost" || channel === "googlechat";
  const shouldConsumeReplyAfterSend = (replyTo: string | undefined) => {
    if (!replyTo) {
      return false;
    }
    // Thread-based channels use replyToId for thread routing, not one-shot
    // quoting — consuming it would orphan subsequent chunks from the thread.
    if (isThreadBasedChannel) {
      return false;
    }
    if (!isSignalChannel) {
      return true;
    }
    // Signal silently drops malformed quote timestamps and group quotes without a
    // quote-author, so only consume inherited reply state when the send can carry
    // quote metadata on the wire.
    return (
      resolveSignalQuoteMetadata({
        replyToId: replyTo,
        quoteAuthor: params.quoteAuthor,
        isGroup: signalIsGroupTarget,
      }).quoteTimestamp !== undefined
    );
  };
  const didSendApplyReply = <T>(
    resultCountBeforeSend: number,
    value?: T,
    sent?: (value: T) => boolean,
  ) => {
    const valueFlag = value === undefined ? undefined : readReplyApplied(value);
    if (valueFlag !== undefined) {
      return valueFlag;
    }
    const resultFlags = results
      .slice(resultCountBeforeSend)
      .map((result) => readReplyApplied(result))
      .filter((flag): flag is boolean => flag !== undefined);
    if (resultFlags.length > 0) {
      return resultFlags.some(Boolean);
    }
    return value !== undefined && sent ? sent(value) : results.length > resultCountBeforeSend;
  };
  const markReplyConsumedIfSendSucceeded = (
    replyTo: string | undefined,
    resultCountBeforeSend: number,
  ) => {
    if (shouldConsumeReplyAfterSend(replyTo) && didSendApplyReply(resultCountBeforeSend)) {
      replyConsumed = true;
    }
  };
  const trackReplyConsumption = async <T>(
    replyTo: string | undefined,
    send: () => Promise<T>,
    sent?: (value: T) => boolean,
  ): Promise<T> => {
    const resultCountBeforeSend = results.length;
    try {
      const value = await send();
      if (
        shouldConsumeReplyAfterSend(replyTo) &&
        didSendApplyReply(resultCountBeforeSend, value, sent)
      ) {
        replyConsumed = true;
      }
      return value;
    } catch (err) {
      // Best-effort delivery should only consume reply metadata once a quoted send
      // actually succeeded, even if a later chunk/send in the same payload fails.
      markReplyConsumedIfSendSucceeded(replyTo, resultCountBeforeSend);
      throw err;
    }
  };
  for (const payload of normalizedPayloads) {
    let payloadSummary = buildPayloadSummary(payload);
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
      });
      if (hookResult.cancelled) {
        continue;
      }
      const effectivePayload = hookResult.payload;
      payloadSummary = hookResult.payloadSummary;

      params.onPayload?.(payloadSummary);
      // Treat null as an explicit "do not reply" override so payload-level suppression
      // is preserved instead of falling back to inherited reply metadata.
      // NOTE: Many payload builders emit replyToId: undefined. Treat that as "no opinion"
      // so the inherited reply metadata can still apply.
      const explicitPayloadReplyTo =
        "replyToId" in effectivePayload && effectivePayload.replyToId !== undefined
          ? effectivePayload.replyToId
          : undefined;
      const inheritedReplyTo =
        explicitPayloadReplyTo === undefined ? (params.replyToId ?? undefined) : undefined;
      const effectiveReplyTo =
        explicitPayloadReplyTo != null
          ? explicitPayloadReplyTo
          : !replyConsumed
            ? inheritedReplyTo
            : undefined;
      // NOTE: quoteAuthor is derived from the top-level params, not resolved per-payload.
      // The normal Signal inbound→outbound path (monitor.ts:deliverReplies) resolves
      // quoteAuthor per-payload via resolveQuoteAuthor(effectiveReplyTo). If a future
      // caller uses deliverOutboundPayloads directly with per-payload replyToId overrides,
      // it should supply its own quoteAuthor resolution or extend this logic.
      const effectiveQuoteAuthor = effectiveReplyTo ? (params.quoteAuthor ?? undefined) : undefined;
      const effectiveSendOverrides = {
        threadId: params.threadId ?? undefined,
        forceDocument: params.forceDocument,
        replyToId:
          explicitPayloadReplyTo !== undefined // explicit payload override (string or null)
            ? (explicitPayloadReplyTo ?? undefined) // null → undefined for the wire format
            : inheritedReplyTo !== undefined
              ? (effectiveReplyTo ?? null)
              : undefined,
      };
      if (handler.sendPayload && effectivePayload.channelData) {
        // Materialize the resolved replyToId on the payload so downstream handlers see
        // the correct value:
        // - string: reply applied
        // - null: reply metadata was inherited but has been consumed (explicitly no reply)
        // - undefined: no reply metadata was ever present (no opinion)
        const resolvedReplyToId =
          effectiveReplyTo !== undefined
            ? effectiveReplyTo
            : inheritedReplyTo !== undefined
              ? null
              : undefined;
        const resolvedPayload = { ...effectivePayload, replyToId: resolvedReplyToId };
        const delivery = await trackReplyConsumption(
          effectiveReplyTo,
          () =>
            handler.sendPayload!(
              resolvedPayload as typeof effectivePayload,
              effectiveSendOverrides,
            ),
          // Any non-undefined return counts as "sent" — channels that don't return
          // messageId (e.g. matrix) should still consume the reply indicator.
          (value) => value !== undefined,
        );
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
          await trackReplyConsumption(effectiveReplyTo, () =>
            sendSignalTextChunks(payloadSummary.text, effectiveReplyTo, effectiveQuoteAuthor),
          );
        } else {
          await trackReplyConsumption(effectiveReplyTo, () =>
            sendTextChunks(payloadSummary.text, effectiveSendOverrides),
          );
        }
        const messageId = results.at(-1)?.messageId;
        emitMessageSent({
          success: results.length > beforeCount,
          content: payloadSummary.text,
          messageId,
        });
        continue;
      }

      if (!handler.supportsMedia) {
        log.warn(
          "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
          {
            channel,
            to,
            mediaCount: payloadSummary.mediaUrls.length,
          },
        );
        const fallbackText = payloadSummary.text.trim();
        if (!fallbackText) {
          throw new Error(
            "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload",
          );
        }
        const beforeCount = results.length;
        await trackReplyConsumption(effectiveReplyTo, () =>
          sendTextChunks(fallbackText, effectiveSendOverrides),
        );
        const messageId = results.at(-1)?.messageId;
        emitMessageSent({
          success: results.length > beforeCount,
          content: payloadSummary.text,
          messageId,
        });
        continue;
      }

      let first = true;
      let lastMessageId: string | undefined;
      await trackReplyConsumption(effectiveReplyTo, async () => {
        for (const url of payloadSummary.mediaUrls) {
          throwIfAborted(abortSignal);
          const caption = first ? payloadSummary.text : "";
          if (isSignalChannel) {
            const mediaReplyTo = first ? effectiveReplyTo : undefined;
            const mediaQuoteAuthor = first ? effectiveQuoteAuthor : undefined;
            const delivery = await sendSignalMedia(caption, url, mediaReplyTo, mediaQuoteAuthor);
            results.push(delivery);
            lastMessageId = delivery.messageId;
          } else {
            const delivery = await handler.sendMedia(caption, url, effectiveSendOverrides);
            results.push(delivery);
            lastMessageId = delivery.messageId;
          }
          first = false;
        }
      });
      emitMessageSent({
        success: true,
        content: payloadSummary.text,
        messageId: lastMessageId,
      });
    } catch (err) {
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
        idempotencyKey: params.mirror.idempotencyKey,
      });
    }
  }

  return results;
}
