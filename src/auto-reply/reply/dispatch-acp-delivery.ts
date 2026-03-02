import type { OpenClawConfig } from "../../config/config.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { logVerbose } from "../../globals.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import type { RelayRouteTarget } from "../../sessions/relay-routing.js";
import { maybeApplyTtsToPayload } from "../../tts/tts.js";
import type { OriginatingChannelType } from "../templating.js";
import type { FinalizedMsgContext } from "../templating.js";
import { hasRelaySkipToken } from "../tokens.js";
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
  routeTarget?: RelayRouteTarget;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  shouldSwallowRelaySkipToken: boolean;
  onReplyStart?: () => Promise<void> | void;
}): AcpDispatchDeliveryCoordinator {
  const routeTarget =
    params.routeTarget ??
    (params.shouldRouteToOriginating && params.originatingChannel && params.originatingTo
      ? {
          channel: params.originatingChannel,
          to: params.originatingTo,
          accountId: params.ctx.AccountId,
          threadId: params.ctx.MessageThreadId,
        }
      : undefined);

  const state: AcpDispatchDeliveryState = {
    startedReplyLifecycle: false,
    accumulatedBlockText: "",
    blockCount: 0,
    routedCounts: {
      tool: 0,
      block: 0,
      final: 0,
    },
    toolMessageByCallId: new Map(),
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
    if (!routeTarget) {
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
    if (params.shouldSwallowRelaySkipToken && hasRelaySkipToken(payload.text)) {
      return false;
    }
    if (kind === "block" && payload.text?.trim()) {
      if (state.accumulatedBlockText.length > 0) {
        state.accumulatedBlockText += "\n";
      }
      state.accumulatedBlockText += payload.text;
      state.blockCount += 1;
    }

    if ((payload.text?.trim() ?? "").length > 0 || payload.mediaUrl || payload.mediaUrls?.length) {
      await startReplyLifecycleOnce();
    }

    const ttsPayload = await maybeApplyTtsToPayload({
      payload,
      cfg: params.cfg,
      channel: params.ttsChannel,
      kind,
      inboundAudio: params.inboundAudio,
      ttsAuto: params.sessionTtsAuto,
    });

    if (routeTarget) {
      const toolCallId = meta?.toolCallId?.trim();
      if (kind === "tool" && meta?.allowEdit === true && toolCallId) {
        const edited = await tryEditToolMessage(ttsPayload, toolCallId);
        if (edited) {
          return true;
        }
      }

      const result = await routeReply({
        payload: ttsPayload,
        channel: routeTarget.channel as OriginatingChannelType,
        to: routeTarget.to,
        sessionKey: params.ctx.SessionKey,
        accountId: routeTarget.accountId,
        threadId: routeTarget.threadId,
        cfg: params.cfg,
      });
      if (!result.ok) {
        logVerbose(
          `dispatch-acp: route-reply (acp/${kind}) failed: ${result.error ?? "unknown error"}`,
        );
        return false;
      }
      if (kind === "tool" && meta?.toolCallId && result.messageId) {
        state.toolMessageByCallId.set(meta.toolCallId, {
          channel: routeTarget.channel,
          accountId: routeTarget.accountId,
          to: routeTarget.to,
          ...(routeTarget.threadId != null ? { threadId: routeTarget.threadId } : {}),
          messageId: result.messageId,
        });
      }
      state.routedCounts[kind] += 1;
      return true;
    }

    if (kind === "tool") {
      return params.dispatcher.sendToolResult(ttsPayload);
    }
    if (kind === "block") {
      return params.dispatcher.sendBlockReply(ttsPayload);
    }
    return params.dispatcher.sendFinalReply(ttsPayload);
  };

  return {
    startReplyLifecycle: startReplyLifecycleOnce,
    deliver,
    getBlockCount: () => state.blockCount,
    getAccumulatedBlockText: () => state.accumulatedBlockText,
    getRoutedCounts: () => ({ ...state.routedCounts }),
    applyRoutedCounts: (counts) => {
      counts.tool += state.routedCounts.tool;
      counts.block += state.routedCounts.block;
      counts.final += state.routedCounts.final;
    },
  };
}
