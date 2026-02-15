import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { sendMessageDiscord } from "../../discord/send.js";
import type { sendMessageIMessage } from "../../imessage/send.js";
import type { sendMessageSlack } from "../../slack/send.js";
import type { sendMessageTelegram } from "../../telegram/send.js";
import type { sendMessageWhatsApp } from "../../web/outbound.js";
import type { OutboundIdentity } from "./identity.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import type { OutboundChannel } from "./targets.js";
import {
  chunkByParagraph,
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import { resolveChannelMediaMaxBytes } from "../../channels/plugins/media-limits.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import {
  appendAssistantMessageToSessionTranscript,
  resolveMirroredTranscriptText,
} from "../../config/sessions.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { markdownToSignalTextChunks, type SignalTextStyleRange } from "../../signal/format.js";
import { sendMessageSignal } from "../../signal/send.js";
import { throwIfAborted } from "./abort.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "./delivery-queue.js";
import { normalizeReplyPayloadsForDelivery } from "./payloads.js";

export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";

type SendMatrixMessage = (
  to: string,
  text: string,
  opts?: { mediaUrl?: string; replyToId?: string; threadId?: string; timeoutMs?: number },
) => Promise<{ messageId: string; roomId: string }>;

export type OutboundSendDeps = {
  sendWhatsApp?: typeof sendMessageWhatsApp;
  sendTelegram?: typeof sendMessageTelegram;
  sendDiscord?: typeof sendMessageDiscord;
  sendSlack?: typeof sendMessageSlack;
  sendSignal?: typeof sendMessageSignal;
  sendIMessage?: typeof sendMessageIMessage;
  sendMatrix?: SendMatrixMessage;
  sendMSTeams?: (
    to: string,
    text: string,
    opts?: { mediaUrl?: string },
  ) => Promise<{ messageId: string; conversationId: string }>;
};

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
  sendPayload?: (payload: ReplyPayload) => Promise<OutboundDeliveryResult>;
  sendText: (text: string) => Promise<OutboundDeliveryResult>;
  sendMedia: (caption: string, mediaUrl: string) => Promise<OutboundDeliveryResult>;
};

// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function createChannelHandler(params: {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  silent?: boolean;
}): Promise<ChannelHandler> {
  const outbound = await loadChannelOutboundAdapter(params.channel);
  if (!outbound?.sendText || !outbound?.sendMedia) {
    throw new Error(`Outbound not configured for channel: ${params.channel}`);
  }
  const handler = createPluginHandler({
    outbound,
    cfg: params.cfg,
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    identity: params.identity,
    deps: params.deps,
    gifPlayback: params.gifPlayback,
    silent: params.silent,
  });
  if (!handler) {
    throw new Error(`Outbound not configured for channel: ${params.channel}`);
  }
  return handler;
}

function createPluginHandler(params: {
  outbound?: ChannelOutboundAdapter;
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  silent?: boolean;
}): ChannelHandler | null {
  const outbound = params.outbound;
  if (!outbound?.sendText || !outbound?.sendMedia) {
    return null;
  }
  const sendText = outbound.sendText;
  const sendMedia = outbound.sendMedia;
  const chunker = outbound.chunker ?? null;
  const chunkerMode = outbound.chunkerMode;
  return {
    chunker,
    chunkerMode,
    textChunkLimit: outbound.textChunkLimit,
    sendPayload: outbound.sendPayload
      ? async (payload) =>
          outbound.sendPayload!({
            cfg: params.cfg,
            to: params.to,
            text: payload.text ?? "",
            mediaUrl: payload.mediaUrl,
            accountId: params.accountId,
            replyToId: params.replyToId,
            threadId: params.threadId,
            identity: params.identity,
            gifPlayback: params.gifPlayback,
            deps: params.deps,
            silent: params.silent,
            payload,
          })
      : undefined,
    sendText: async (text) =>
      sendText({
        cfg: params.cfg,
        to: params.to,
        text,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        identity: params.identity,
        gifPlayback: params.gifPlayback,
        deps: params.deps,
        silent: params.silent,
      }),
    sendMedia: async (caption, mediaUrl) =>
      sendMedia({
        cfg: params.cfg,
        to: params.to,
        text: caption,
        mediaUrl,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        identity: params.identity,
        gifPlayback: params.gifPlayback,
        deps: params.deps,
        silent: params.silent,
      }),
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
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  mirror?: {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
  };
  silent?: boolean;
};

type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
  /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
  skipQueue?: boolean;
};

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
  const sendSignal = params.deps?.sendSignal ?? sendMessageSignal;
  const results: OutboundDeliveryResult[] = [];
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
  });
  const textLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, channel, accountId, {
        fallbackLimit: handler.textChunkLimit,
      })
    : undefined;
  const chunkMode = handler.chunker ? resolveChunkMode(cfg, channel, accountId) : "length";
  const isSignalChannel = channel === "signal";
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

  const sendTextChunks = async (text: string) => {
    throwIfAborted(abortSignal);
    if (!handler.chunker || textLimit === undefined) {
      results.push(await handler.sendText(text));
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
          results.push(await handler.sendText(chunk));
        }
      }
      return;
    }
    const chunks = handler.chunker(text, textLimit);
    for (const chunk of chunks) {
      throwIfAborted(abortSignal);
      results.push(await handler.sendText(chunk));
    }
  };

  const sendSignalText = async (text: string, styles: SignalTextStyleRange[]) => {
    throwIfAborted(abortSignal);
    return {
      channel: "signal" as const,
      ...(await sendSignal(to, text, {
        maxBytes: signalMaxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: styles,
      })),
    };
  };

  const sendSignalTextChunks = async (text: string) => {
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
    for (const chunk of signalChunks) {
      throwIfAborted(abortSignal);
      results.push(await sendSignalText(chunk.text, chunk.styles));
    }
  };

  const sendSignalMedia = async (caption: string, mediaUrl: string) => {
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
        mediaUrl,
        maxBytes: signalMaxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: formatted.styles,
      })),
    };
  };
  const normalizeWhatsAppPayload = (payload: ReplyPayload): ReplyPayload | null => {
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
  for (const payload of normalizedPayloads) {
    const payloadSummary: NormalizedOutboundPayload = {
      text: payload.text ?? "",
      mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
      channelData: payload.channelData,
    };
    const emitMessageSent = (success: boolean, error?: string) => {
      if (!hookRunner?.hasHooks("message_sent")) {
        return;
      }
      void hookRunner
        .runMessageSent(
          {
            to,
            content: payloadSummary.text,
            success,
            ...(error ? { error } : {}),
          },
          {
            channelId: channel,
            accountId: accountId ?? undefined,
          },
        )
        .catch(() => {});
    };
    try {
      throwIfAborted(abortSignal);

      // Run message_sending plugin hook (may modify content or cancel)
      let effectivePayload = payload;
      if (hookRunner?.hasHooks("message_sending")) {
        try {
          const sendingResult = await hookRunner.runMessageSending(
            {
              to,
              content: payloadSummary.text,
              metadata: { channel, accountId, mediaUrls: payloadSummary.mediaUrls },
            },
            {
              channelId: channel,
              accountId: accountId ?? undefined,
            },
          );
          if (sendingResult?.cancel) {
            continue;
          }
          if (sendingResult?.content != null) {
            effectivePayload = { ...payload, text: sendingResult.content };
            payloadSummary.text = sendingResult.content;
          }
        } catch {
          // Don't block delivery on hook failure
        }
      }

      params.onPayload?.(payloadSummary);
      if (handler.sendPayload && effectivePayload.channelData) {
        results.push(await handler.sendPayload(effectivePayload));
        emitMessageSent(true);
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        if (isSignalChannel) {
          await sendSignalTextChunks(payloadSummary.text);
        } else {
          await sendTextChunks(payloadSummary.text);
        }
        emitMessageSent(true);
        continue;
      }

      let first = true;
      for (const url of payloadSummary.mediaUrls) {
        throwIfAborted(abortSignal);
        const caption = first ? payloadSummary.text : "";
        first = false;
        if (isSignalChannel) {
          results.push(await sendSignalMedia(caption, url));
        } else {
          results.push(await handler.sendMedia(caption, url));
        }
      }
      emitMessageSent(true);
    } catch (err) {
      emitMessageSent(false, err instanceof Error ? err.message : String(err));
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
