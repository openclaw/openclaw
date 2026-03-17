import type { AcpGatewayRunDeliveryTargetRecord } from "../../acp/store/types.js";
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
};

type ToolMessageHandle = {
  channel: string;
  accountId?: string;
  to: string;
  threadId?: string | number;
  messageId: string;
};

type AcpDispatchDeliveryState = {
  startedReplyLifecycle: boolean;
  accumulatedBlockText: string;
  blockCount: number;
  syntheticFinalDelivered: boolean;
  routedCounts: Record<ReplyDispatchKind, number>;
  toolMessageByCallId: Map<string, ToolMessageHandle>;
};

export function createAcpDispatchDeliveryState(): AcpDispatchDeliveryState {
  return {
    startedReplyLifecycle: false,
    accumulatedBlockText: "",
    blockCount: 0,
    syntheticFinalDelivered: false,
    routedCounts: {
      tool: 0,
      block: 0,
      final: 0,
    },
    toolMessageByCallId: new Map(),
  };
}

export type AcpDispatchDeliveryCoordinator = {
  startReplyLifecycle: () => Promise<void>;
  deliver: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ) => Promise<boolean>;
  getBlockCount: () => number;
  getAccumulatedBlockText: () => string;
  resolveSyntheticFinalPayload: () => Promise<ReplyPayload | null>;
  markSyntheticFinalDelivered: () => void;
  getRoutedCounts: () => Record<ReplyDispatchKind, number>;
  applyRoutedCounts: (counts: Record<ReplyDispatchKind, number>) => void;
};

export async function resolveAcpSyntheticFinalTtsPayload(params: {
  cfg: OpenClawConfig;
  accumulatedBlockText: string;
  blockCount: number;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
}): Promise<ReplyPayload | null> {
  if (params.blockCount <= 0 || !params.accumulatedBlockText.trim()) {
    return null;
  }
  const ttsSyntheticReply = await maybeApplyTtsToPayload({
    payload: { text: params.accumulatedBlockText },
    cfg: params.cfg,
    channel: params.ttsChannel,
    kind: "final",
    inboundAudio: params.inboundAudio,
    ttsAuto: params.sessionTtsAuto,
  });
  if (!ttsSyntheticReply.mediaUrl) {
    return null;
  }
  return {
    mediaUrl: ttsSyntheticReply.mediaUrl,
    ...(ttsSyntheticReply.audioAsVoice ? { audioAsVoice: ttsSyntheticReply.audioAsVoice } : {}),
  };
}

export function buildAcpRunDeliveryTarget(params: {
  sessionKey: string;
  runId: string;
  ctx: FinalizedMsgContext;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  now?: number;
}): AcpGatewayRunDeliveryTargetRecord | null {
  const now = params.now ?? Date.now();
  const routeMode =
    params.shouldRouteToOriginating && params.originatingChannel && params.originatingTo
      ? "originating"
      : "session";
  const channel =
    routeMode === "originating"
      ? params.originatingChannel?.trim()
      : String(params.ctx.Surface ?? params.ctx.Provider ?? "").trim();
  const to =
    routeMode === "originating" ? params.originatingTo?.trim() : String(params.ctx.To ?? "").trim();
  if (!channel || !to) {
    return null;
  }
  return {
    targetKey: `${params.runId}:primary`,
    targetId: "primary",
    sessionKey: params.sessionKey,
    runId: params.runId,
    channel,
    to,
    ...((params.ctx.Surface ?? params.ctx.Provider)
      ? { provider: String(params.ctx.Surface ?? params.ctx.Provider) }
      : {}),
    ...(params.ctx.AccountId ? { accountId: params.ctx.AccountId } : {}),
    ...(params.ctx.MessageThreadId != null ? { threadId: params.ctx.MessageThreadId } : {}),
    routeMode,
    toolReplayPolicy: "append_only_after_restart",
    ...(params.inboundAudio ? { inboundAudio: params.inboundAudio } : {}),
    ...(params.sessionTtsAuto ? { sessionTtsAuto: params.sessionTtsAuto } : {}),
    ...(params.ttsChannel ? { ttsChannel: params.ttsChannel } : {}),
    createdAt: now,
    updatedAt: now,
    ...(params.ctx.ChatType === "group" || params.ctx.ChatType === "channel"
      ? { isGroup: true }
      : {}),
    ...(params.ctx.NativeChannelId ? { groupId: params.ctx.NativeChannelId } : {}),
  };
}

export function createAcpDispatchDeliveryCoordinator(params: {
  cfg: OpenClawConfig;
  ctx?: FinalizedMsgContext;
  dispatcher?: ReplyDispatcher;
  target?: AcpGatewayRunDeliveryTargetRecord;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  onReplyStart?: () => Promise<void> | void;
  restartMode?: boolean;
  state?: AcpDispatchDeliveryState;
}): AcpDispatchDeliveryCoordinator {
  const state = params.state ?? createAcpDispatchDeliveryState();
  const inboundAudio = params.inboundAudio || params.target?.inboundAudio === true;
  const sessionTtsAuto = params.sessionTtsAuto ?? params.target?.sessionTtsAuto;
  const ttsChannel = params.ttsChannel ?? params.target?.ttsChannel;

  const startReplyLifecycleOnce = async () => {
    if (state.startedReplyLifecycle) {
      return;
    }
    state.startedReplyLifecycle = true;
    await params.onReplyStart?.();
  };

  const recordConfirmedBlockDelivery = (payload: ReplyPayload) => {
    const text = payload.text?.trim();
    if (!text) {
      return;
    }
    if (state.accumulatedBlockText.length > 0) {
      state.accumulatedBlockText += "\n";
    }
    state.accumulatedBlockText += payload.text!;
    state.blockCount += 1;
  };

  const tryEditToolMessage = async (
    payload: ReplyPayload,
    toolCallId: string,
  ): Promise<boolean> => {
    const sessionKey = params.ctx?.SessionKey ?? params.target?.sessionKey;
    if (!sessionKey) {
      return false;
    }
    if (params.restartMode) {
      return false;
    }
    const routeChannel =
      params.target?.channel ??
      (params.shouldRouteToOriginating ? params.originatingChannel : undefined);
    const routeTo =
      params.target?.to ?? (params.shouldRouteToOriginating ? params.originatingTo : undefined);
    if (!routeChannel || !routeTo) {
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
        sessionKey,
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
    if ((payload.text?.trim() ?? "").length > 0 || payload.mediaUrl || payload.mediaUrls?.length) {
      await startReplyLifecycleOnce();
    }

    const ttsPayload = await maybeApplyTtsToPayload({
      payload,
      cfg: params.cfg,
      channel: ttsChannel,
      kind,
      inboundAudio,
      ttsAuto: sessionTtsAuto,
    });

    const routeChannel =
      params.target?.channel ??
      (params.shouldRouteToOriginating ? params.originatingChannel : undefined);
    const routeTo =
      params.target?.to ?? (params.shouldRouteToOriginating ? params.originatingTo : undefined);
    const routeSessionKey = params.ctx?.SessionKey ?? params.target?.sessionKey;
    const routeAccountId = params.ctx?.AccountId ?? params.target?.accountId;
    const routeThreadId = params.ctx?.MessageThreadId ?? params.target?.threadId;
    const routeProvider = params.ctx?.Surface ?? params.ctx?.Provider ?? params.target?.provider;
    const shouldUseRouteReply =
      Boolean(routeChannel && routeTo) &&
      (params.target != null || params.shouldRouteToOriginating);

    if (shouldUseRouteReply && routeChannel && routeTo) {
      const toolCallId = meta?.toolCallId?.trim();
      if (kind === "tool" && meta?.allowEdit === true && toolCallId) {
        const edited = await tryEditToolMessage(ttsPayload, toolCallId);
        if (edited) {
          return true;
        }
      }

      const result = await routeReply({
        payload: ttsPayload,
        channel: routeChannel,
        to: routeTo,
        sessionKey: routeSessionKey,
        accountId: routeAccountId,
        threadId: routeThreadId,
        cfg: params.cfg,
        ...(params.target?.isGroup != null ? { isGroup: params.target.isGroup } : {}),
        ...(params.target?.groupId ? { groupId: params.target.groupId } : {}),
      });
      if (!result.ok) {
        logVerbose(
          `dispatch-acp: route-reply (acp/${kind}) failed: ${result.error ?? "unknown error"}`,
        );
        return false;
      }
      if (kind === "block") {
        recordConfirmedBlockDelivery(payload);
      }
      if (kind === "tool" && meta?.toolCallId && result.messageId) {
        state.toolMessageByCallId.set(meta.toolCallId, {
          channel: routeChannel,
          accountId: routeAccountId,
          to: routeTo,
          ...(routeThreadId != null ? { threadId: routeThreadId } : {}),
          messageId: result.messageId,
        });
      }
      state.routedCounts[kind] += 1;
      return true;
    }

    if (!params.dispatcher) {
      logVerbose(
        `dispatch-acp: no dispatcher or routable target available for acp/${kind}${routeProvider ? ` on ${routeProvider}` : ""}`,
      );
      return false;
    }
    const queued =
      kind === "tool"
        ? params.dispatcher.sendToolResult(ttsPayload)
        : kind === "block"
          ? params.dispatcher.sendBlockReply(ttsPayload)
          : params.dispatcher.sendFinalReply(ttsPayload);
    if (queued && kind === "block") {
      recordConfirmedBlockDelivery(payload);
    }
    return queued;
  };

  return {
    startReplyLifecycle: startReplyLifecycleOnce,
    deliver,
    getBlockCount: () => state.blockCount,
    getAccumulatedBlockText: () => state.accumulatedBlockText,
    resolveSyntheticFinalPayload: async () => {
      if (state.syntheticFinalDelivered) {
        return null;
      }
      return await resolveAcpSyntheticFinalTtsPayload({
        cfg: params.cfg,
        accumulatedBlockText: state.accumulatedBlockText,
        blockCount: state.blockCount,
        inboundAudio,
        sessionTtsAuto,
        ttsChannel,
      });
    },
    markSyntheticFinalDelivered: () => {
      state.syntheticFinalDelivered = true;
    },
    getRoutedCounts: () => ({ ...state.routedCounts }),
    applyRoutedCounts: (counts) => {
      counts.tool += state.routedCounts.tool;
      counts.block += state.routedCounts.block;
      counts.final += state.routedCounts.final;
    },
  };
}
