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
import type { sendMessageTelegram } from "../../telegram/send.js";
import { throwIfAborted } from "./abort.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "./delivery-queue.js";
import type { OutboundIdentity } from "./identity.js";
import type { DeliveryMirror } from "./mirror.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import { normalizeReplyPayloadsForDelivery } from "./payloads.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");
const TELEGRAM_TEXT_LIMIT = 4096;

export type OutboundSendDeps = {
  sendTelegram?: typeof sendMessageTelegram;
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
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
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
    replyToId: overrides?.replyToId ?? baseCtx.replyToId,
    threadId: overrides?.threadId ?? baseCtx.threadId,
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
    threadId: params.threadId,
    identity: params.identity,
    gifPlayback: params.gifPlayback,
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
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
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
  if (!rawText.trim()) {
    if (!hasMedia && !hasChannelData) {
      return null;
    }
    return {
      ...payload,
      text: "",
    };
  }
  return payload;
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
    const normalized = normalizePayloadForChannelDelivery(payload, channel);
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
  const textLimit =
    channel === "telegram" && typeof configuredTextLimit === "number"
      ? Math.min(configuredTextLimit, TELEGRAM_TEXT_LIMIT)
      : configuredTextLimit;
  const chunkMode = handler.chunker ? resolveChunkMode(cfg, channel, accountId) : "length";

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
        await sendTextChunks(payloadSummary.text, sendOverrides);
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
        await sendTextChunks(fallbackText, sendOverrides);
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
      for (const url of payloadSummary.mediaUrls) {
        throwIfAborted(abortSignal);
        const caption = first ? payloadSummary.text : "";
        first = false;
        const delivery = await handler.sendMedia(caption, url, sendOverrides);
        results.push(delivery);
        lastMessageId = delivery.messageId;
      }
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
