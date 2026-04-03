import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig } from "../../config/config.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { logVerbose } from "../../globals.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { maybeApplyTtsToPayload } from "../../tts/tts.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { routeReply } from "./route-reply.js";

export type AcpDispatchDeliveryMeta = {
  toolCallId?: string;
  allowEdit?: boolean;
  skipTts?: boolean;
};

type ToolMessageHandle = {
  channel: string;
  accountId?: string;
  to: string;
  threadId?: string | number;
  messageId: string;
};

function normalizeDeliveryChannel(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function shouldTreatDeliveredTextAsVisible(params: {
  channel: string | undefined;
  kind: ReplyDispatchKind;
  text: string | undefined;
}): boolean {
  if (!params.text?.trim()) {
    return false;
  }
  if (params.kind === "final") {
    return true;
  }
  return normalizeDeliveryChannel(params.channel) === "telegram";
}

type AcpDispatchDeliveryState = {
  startedReplyLifecycle: boolean;
  accumulatedBlockText: string;
  blockCount: number;
  deliveredFinalReply: boolean;
  deliveredVisibleText: boolean;
  failedVisibleTextDelivery: boolean;
  queuedDirectVisibleTextDeliveries: number;
  settledDirectVisibleText: boolean;
  routedCounts: Record<ReplyDispatchKind, number>;
  toolMessageByCallId: Map<string, ToolMessageHandle>;
};

export type AcpDispatchDeliveryCoordinator = {
  startReplyLifecycle: () => Promise<void>;
  deliver: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ) => Promise<boolean>;
  getBlockCount: () => number;
  getAccumulatedBlockText: () => string;
  settleVisibleText: () => Promise<void>;
  hasDeliveredFinalReply: () => boolean;
  hasDeliveredVisibleText: () => boolean;
  hasFailedVisibleTextDelivery: () => boolean;
  getRoutedCounts: () => Record<ReplyDispatchKind, number>;
  applyRoutedCounts: (counts: Record<ReplyDispatchKind, number>) => void;
};

export function createAcpDispatchDeliveryCoordinator(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
  replyMode?: string;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  onReplyStart?: () => Promise<void> | void;
}): AcpDispatchDeliveryCoordinator {
  const state: AcpDispatchDeliveryState = {
    startedReplyLifecycle: false,
    accumulatedBlockText: "",
    blockCount: 0,
    deliveredFinalReply: false,
    deliveredVisibleText: false,
    failedVisibleTextDelivery: false,
    queuedDirectVisibleTextDeliveries: 0,
    settledDirectVisibleText: false,
    routedCounts: {
      tool: 0,
      block: 0,
      final: 0,
    },
    toolMessageByCallId: new Map(),
  };
  const directChannel = normalizeDeliveryChannel(params.ctx.Provider ?? params.ctx.Surface);
  const routedChannel = normalizeDeliveryChannel(params.originatingChannel);

  const settleDirectVisibleText = async () => {
    if (state.settledDirectVisibleText || state.queuedDirectVisibleTextDeliveries === 0) {
      return;
    }
    state.settledDirectVisibleText = true;
    await params.dispatcher.waitForIdle();
    const failedCounts = params.dispatcher.getFailedCounts();
    const failedVisibleCount = failedCounts.block + failedCounts.final;
    if (failedVisibleCount > 0) {
      state.failedVisibleTextDelivery = true;
    }
    if (state.queuedDirectVisibleTextDeliveries > failedVisibleCount) {
      state.deliveredVisibleText = true;
    }
  };

  const startReplyLifecycleOnce = async () => {
    if (state.startedReplyLifecycle) {
      return;
    }
    state.startedReplyLifecycle = true;
    await params.onReplyStart?.();
  };

  const tryEditToolMessage = async (
    payload: ReplyPayload,
    toolCallId: string,
  ): Promise<boolean> => {
    if (!params.shouldRouteToOriginating || !params.originatingChannel || !params.originatingTo) {
      return false;
    }
    const handle = state.toolMessageByCallId.get(toolCallId);
    if (!handle?.messageId) {
      return false;
    }
    const message = payload.text?.trim();
    if (!message) {
      return false;
    }

    try {
      await runMessageAction({
        cfg: params.cfg,
        action: "edit",
        params: {
          channel: handle.channel,
          accountId: handle.accountId,
          to: handle.to,
          threadId: handle.threadId,
          messageId: handle.messageId,
          message,
        },
        sessionKey: params.ctx.SessionKey,
      });
      state.routedCounts.tool += 1;
      return true;
    } catch (error) {
      logVerbose(
        `dispatch-acp: tool message edit failed for ${toolCallId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };

  const deliver = async (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ): Promise<boolean> => {
    if (kind === "block" && payload.text?.trim()) {
      if (state.accumulatedBlockText.length > 0) {
        state.accumulatedBlockText += "\n";
      }
      state.accumulatedBlockText += payload.text;
      state.blockCount += 1;
    }

    if (hasOutboundReplyContent(payload, { trimText: true })) {
      await startReplyLifecycleOnce();
    }

    if (params.suppressUserDelivery) {
      return false;
    }

    // ── tool-only mode: suppress everything except media/error finals ──
    // Block streaming text, ACP tool summaries (auto-generated narration),
    // and text-only finals. Allow media-bearing finals and error finals through.
    if (params.replyMode === "tool-only") {
      if (kind === "block") {
        return false;
      }
      if (kind === "tool") {
        return false;
      }
      if (kind === "final") {
        const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
        const isError = Boolean(payload.isError);
        if (!hasMedia && !isError) {
          return false;
        }
      }
    }

    const ttsPayload = meta?.skipTts
      ? payload
      : await maybeApplyTtsToPayload({
          payload,
          cfg: params.cfg,
          channel: params.ttsChannel,
          kind,
          inboundAudio: params.inboundAudio,
          ttsAuto: params.sessionTtsAuto,
        });

    if (params.shouldRouteToOriginating && params.originatingChannel && params.originatingTo) {
      const toolCallId = meta?.toolCallId?.trim();
      if (kind === "tool" && meta?.allowEdit === true && toolCallId) {
        const edited = await tryEditToolMessage(ttsPayload, toolCallId);
        if (edited) {
          return true;
        }
      }

      const tracksVisibleText = shouldTreatDeliveredTextAsVisible({
        channel: routedChannel,
        kind,
        text: ttsPayload.text,
      });
      const result = await routeReply({
        payload: ttsPayload,
        channel: params.originatingChannel,
        to: params.originatingTo,
        sessionKey: params.ctx.SessionKey,
        accountId: params.ctx.AccountId,
        threadId: params.ctx.MessageThreadId,
        cfg: params.cfg,
      });
      if (!result.ok) {
        if (tracksVisibleText) {
          state.failedVisibleTextDelivery = true;
        }
        logVerbose(
          `dispatch-acp: route-reply (acp/${kind}) failed: ${result.error ?? "unknown error"}`,
        );
        return false;
      }
      if (kind === "tool" && meta?.toolCallId && result.messageId) {
        state.toolMessageByCallId.set(meta.toolCallId, {
          channel: params.originatingChannel,
          accountId: params.ctx.AccountId,
          to: params.originatingTo,
          ...(params.ctx.MessageThreadId != null ? { threadId: params.ctx.MessageThreadId } : {}),
          messageId: result.messageId,
        });
      }
      if (kind === "final") {
        state.deliveredFinalReply = true;
      }
      if (tracksVisibleText) {
        state.deliveredVisibleText = true;
      }
      state.routedCounts[kind] += 1;
      return true;
    }

    const tracksVisibleText = shouldTreatDeliveredTextAsVisible({
      channel: directChannel,
      kind,
      text: ttsPayload.text,
    });
    const delivered =
      kind === "tool"
        ? params.dispatcher.sendToolResult(ttsPayload)
        : kind === "block"
          ? params.dispatcher.sendBlockReply(ttsPayload)
          : params.dispatcher.sendFinalReply(ttsPayload);
    if (kind === "final" && delivered) {
      state.deliveredFinalReply = true;
    }
    if (delivered && tracksVisibleText) {
      state.queuedDirectVisibleTextDeliveries += 1;
      state.settledDirectVisibleText = false;
    } else if (!delivered && tracksVisibleText) {
      state.failedVisibleTextDelivery = true;
    }
    return delivered;
  };

  return {
    startReplyLifecycle: startReplyLifecycleOnce,
    deliver,
    getBlockCount: () => state.blockCount,
    getAccumulatedBlockText: () => state.accumulatedBlockText,
    settleVisibleText: settleDirectVisibleText,
    hasDeliveredFinalReply: () => state.deliveredFinalReply,
    hasDeliveredVisibleText: () => state.deliveredVisibleText,
    hasFailedVisibleTextDelivery: () => state.failedVisibleTextDelivery,
    getRoutedCounts: () => ({ ...state.routedCounts }),
    applyRoutedCounts: (counts) => {
      counts.tool += state.routedCounts.tool;
      counts.block += state.routedCounts.block;
      counts.final += state.routedCounts.final;
    },
  };
}
