import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { sendMessageDiscord } from "../../discord/send.js";
import type { sendMessageIMessage } from "../../imessage/send.js";
import type { sendMessageSlack } from "../../slack/send.js";
import type { sendMessageTelegram } from "../../telegram/send.js";
import type { sendMessageWhatsApp } from "../../web/outbound.js";
import type { HitlApprovalDecision } from "../hitl/approval-manager.js";
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
import { markdownToSignalTextChunks, type SignalTextStyleRange } from "../../signal/format.js";
import { sendMessageSignal } from "../../signal/send.js";
import {
  matchesHitlAllowlist,
  loadHitlAllowlist,
  addHitlAllowlistEntry,
} from "../hitl/allowlist.js";
import { createHitlRequest } from "../hitl/client.js";
import { hitlApprovalManager } from "../hitl/state.js";
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

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new Error("Outbound delivery aborted");
  }
}

// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function createChannelHandler(params: {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
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
    deps: params.deps,
    gifPlayback: params.gifPlayback,
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
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
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
            gifPlayback: params.gifPlayback,
            deps: params.deps,
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
        gifPlayback: params.gifPlayback,
        deps: params.deps,
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
        gifPlayback: params.gifPlayback,
        deps: params.deps,
      }),
  };
}

export async function deliverOutboundPayloads(params: {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  threadId?: string | number | null;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  approval?: {
    /** Internal escape hatch to avoid approval recursion (e.g. approval notifications). */
    bypassHitl?: boolean;
  };
  mirror?: {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
  };
}): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to, payloads } = params;
  const accountId = params.accountId;
  const deps = params.deps;
  const abortSignal = params.abortSignal;
  const sendSignal = params.deps?.sendSignal ?? sendMessageSignal;
  const results: OutboundDeliveryResult[] = [];

  // HITL outbound approval gate (central choke point).
  if (!params.approval?.bypassHitl) {
    const hitl = cfg.approvals?.hitl;
    const mode = hitl?.outbound?.mode ?? "off";
    const enabled = hitl?.enabled === true && mode !== "off";
    if (enabled) {
      const keyParts = [
        `outbound`,
        channel,
        `to=${to}`,
        ...(accountId ? [`account=${accountId}`] : []),
        ...(params.threadId !== undefined && params.threadId !== null
          ? [`thread=${String(params.threadId)}`]
          : []),
      ];
      const allowKey = keyParts.join(":");
      const persisted = loadHitlAllowlist();
      const allowPatterns = [
        ...(hitl?.outbound?.allowlist ?? []),
        ...(persisted.entries.map((e) => e.pattern) ?? []),
      ];
      const allowlisted = matchesHitlAllowlist(allowPatterns, allowKey);
      const requiresApproval = !allowlisted && (mode === "always" || mode === "on-miss");
      if (requiresApproval) {
        const defaultDecision: HitlApprovalDecision = hitl?.defaultDecision ?? "deny";
        const timeoutSecondsRaw = hitl?.timeoutSeconds ?? 120;
        const timeoutSeconds = Math.min(86_400, Math.max(60, Math.floor(timeoutSecondsRaw)));
        const timeoutMs = timeoutSeconds * 1000;

        const normalizedPayloads = normalizeReplyPayloadsForDelivery(payloads);
        const mediaCount = normalizedPayloads.reduce((sum, p) => {
          const urls = p.mediaUrls ?? (p.mediaUrl ? [p.mediaUrl] : []);
          return sum + urls.length;
        }, 0);
        const preview =
          normalizedPayloads
            .map((p) => (p.text ?? "").trim())
            .find((t) => t.length > 0)
            ?.slice(0, 240) ?? "";

        const requestLines: string[] = [
          "Outbound side-effect approval required.",
          "",
          `Channel: ${channel}`,
          `To: ${to}`,
          ...(accountId ? [`Account: ${accountId}`] : []),
          ...(params.threadId !== undefined && params.threadId !== null
            ? [`Thread: ${String(params.threadId)}`]
            : []),
          `Media: ${mediaCount}`,
          ...(preview ? ["", "Preview:", preview] : []),
          ...(params.mirror?.sessionKey ? ["", `Session: ${params.mirror.sessionKey}`] : []),
        ];
        let requestText = requestLines.join("\n").trim();
        if (requestText.length > 1900) {
          requestText = `${requestText.slice(0, 1900)}…`;
        }

        const record = hitlApprovalManager.create({
          kind: "outbound",
          timeoutMs,
          defaultDecision,
          summary: { channel, to, accountId: accountId ?? null, threadId: params.threadId ?? null },
          id: null,
        });
        const decisionPromise = hitlApprovalManager.waitForDecision(record, timeoutMs);

        const callbackUrl =
          typeof hitl?.callbackUrl === "string" && hitl.callbackUrl.trim()
            ? hitl.callbackUrl.trim()
            : undefined;

        const hitlCreate = await createHitlRequest({
          apiKey: hitl?.apiKey ?? "",
          loopId: hitl?.loopId ?? "",
          request: {
            processing_type: "time-sensitive",
            type: "markdown",
            priority: "high",
            request_text: requestText,
            timeout_seconds: timeoutSeconds,
            response_type: "single_select",
            response_config: {
              options: [
                { value: "allow-once", label: "Allow once" },
                { value: "allow-always", label: "Allow always" },
                { value: "deny", label: "Deny" },
              ],
              required: true,
            },
            default_response: defaultDecision,
            ...(callbackUrl ? { callback_url: callbackUrl } : {}),
            platform: "api",
            context: {
              kind: "outbound",
              channel,
              to,
              accountId: accountId ?? null,
              threadId: params.threadId ?? null,
              key: allowKey,
            },
          },
        });
        if (!hitlCreate.ok) {
          // Secure-by-default: if HITL is required but unavailable, block the send.
          throw new Error(hitlCreate.error);
        }
        hitlApprovalManager.attachHitlRequestId(record.id, hitlCreate.requestId);

        const decision = (await decisionPromise) ?? defaultDecision;
        if (decision === "deny") {
          throw new Error("Outbound delivery blocked by HITL approval");
        }
        if (decision === "allow-always") {
          // Persist a stable pattern (recipient-scoped) to bypass future approvals.
          const pattern = `outbound:${channel}:to=${to}${accountId ? `:account=${accountId}` : ""}:**`;
          addHitlAllowlistEntry(pattern);
        }
      }
    }
  }

  const handler = await createChannelHandler({
    cfg,
    channel,
    to,
    deps,
    accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    gifPlayback: params.gifPlayback,
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
  const normalizedPayloads = normalizeReplyPayloadsForDelivery(payloads);
  for (const payload of normalizedPayloads) {
    const payloadSummary: NormalizedOutboundPayload = {
      text: payload.text ?? "",
      mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
      channelData: payload.channelData,
    };
    try {
      throwIfAborted(abortSignal);
      params.onPayload?.(payloadSummary);
      if (handler.sendPayload && payload.channelData) {
        results.push(await handler.sendPayload(payload));
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        if (isSignalChannel) {
          await sendSignalTextChunks(payloadSummary.text);
        } else {
          await sendTextChunks(payloadSummary.text);
        }
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
    } catch (err) {
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
