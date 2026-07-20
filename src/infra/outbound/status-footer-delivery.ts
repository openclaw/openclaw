import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { channelSupportsMessageCapabilityForChannel } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.adapters.js";
import {
  createStatusFooterConversationKey,
  decorateIntermediate,
  finalize,
  noteActivity,
  resolveStatusFooterMode,
  STATUS_FOOTER_MAX_RENDERED_CHARS,
} from "../../channels/status-footer.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { throwIfAborted } from "./abort.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import { planOutboundTextMessageUnits, type OutboundMessageSendOverrides } from "./message-plan.js";

type StatusFooterDeliveryContext = { kind: ReplyDispatchKind; runId?: string };

type StatusFooterDeliveryParams = {
  cfg: OpenClawConfig;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  formatting?: { parseMode?: "HTML" };
  session?: { key?: string; agentId?: string };
  gatewayClientScopes?: readonly string[];
  replyPayloadSendingHook?: StatusFooterDeliveryContext;
  statusFooter?: StatusFooterDeliveryContext;
};

type StatusFooterTextHandler = {
  chunker: ChannelOutboundAdapter["chunker"] | null;
  chunkerMode?: "text" | "markdown";
  chunkedTextFormatting?: OutboundDeliveryFormattingOptions;
  sendText: (
    text: string,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult>;
};

function resolveStatusFooterDeliveryContext(
  params: Pick<StatusFooterDeliveryParams, "replyPayloadSendingHook" | "statusFooter">,
): StatusFooterDeliveryContext | undefined {
  if (params.statusFooter) {
    const runId = params.statusFooter.runId ?? params.replyPayloadSendingHook?.runId;
    return { ...params.statusFooter, ...(runId ? { runId } : {}) };
  }
  const hook = params.replyPayloadSendingHook;
  return hook ? { kind: hook.kind, ...(hook.runId ? { runId: hook.runId } : {}) } : undefined;
}

function createConversationKey(params: StatusFooterDeliveryParams): string {
  return createStatusFooterConversationKey(params.channel, params.to, {
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
  });
}

function isStatusFooterEligiblePayload(payload: ReplyPayload | undefined): payload is ReplyPayload {
  return Boolean(
    payload?.text?.trim() &&
    payload.isError !== true &&
    payload.isReasoning !== true &&
    payload.isCommentary !== true &&
    payload.isCompactionNotice !== true &&
    payload.isFallbackNotice !== true &&
    payload.isStatusNotice !== true &&
    !payload.presentation &&
    !payload.interactive &&
    !payload.channelData,
  );
}

function resolveDeliveryMessageId(delivery: OutboundDeliveryResult): string | undefined {
  return (
    delivery.messageId ??
    delivery.receipt?.primaryPlatformMessageId ??
    delivery.receipt?.platformMessageIds.at(-1)
  );
}

function createStatusFooterMessageEditor(
  params: StatusFooterDeliveryParams,
  channelId: string | null,
): (messageId: string, text: string) => Promise<void> {
  return async (messageId, text) => {
    if (!channelId) {
      throw new Error(`Status footer edit unavailable for channel: ${params.channel}`);
    }
    const actions = getChannelPlugin(channelId)?.actions;
    if (!actions?.handleAction || actions.supportsAction?.({ action: "edit" }) === false) {
      throw new Error(`Status footer edit unavailable for channel: ${params.channel}`);
    }
    await actions.handleAction({
      channel: channelId,
      action: "edit",
      cfg: params.cfg,
      params: {
        to: params.to,
        messageId,
        content: text,
        ...(params.formatting?.parseMode === "HTML" ? { textMode: "html" } : {}),
      },
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.session?.key ? { sessionKey: params.session.key } : {}),
      ...(params.session?.agentId ? { agentId: params.session.agentId } : {}),
      ...(params.gatewayClientScopes ? { gatewayClientScopes: params.gatewayClientScopes } : {}),
      toolContext: {
        currentChannelProvider: channelId,
        currentChannelId: params.to,
        currentMessagingTarget: params.to,
        currentMessageId: messageId,
        skipCrossContextDecoration: true,
      },
    });
  };
}

export async function finalizeStatusFooterBeforeDelivery(
  params: StatusFooterDeliveryParams,
): Promise<void> {
  const context = resolveStatusFooterDeliveryContext(params);
  if (context?.kind === "final") {
    await finalize(createConversationKey(params), context.runId);
  }
}

export function createStatusFooterDeliveryPlan(
  params: StatusFooterDeliveryParams,
  textLimit: number | undefined,
) {
  const context = resolveStatusFooterDeliveryContext(params);
  const conversationKey = createConversationKey(params);
  const mode = resolveStatusFooterMode(params.cfg, params.channel);
  const channelId = normalizeChannelId(params.channel);
  const enabled = Boolean(
    context &&
    context.kind !== "final" &&
    mode !== "off" &&
    (textLimit === undefined || textLimit > STATUS_FOOTER_MAX_RENDERED_CHARS) &&
    channelId &&
    channelSupportsMessageCapabilityForChannel(
      {
        cfg: params.cfg,
        channel: params.channel,
        currentChannelProvider: params.channel,
        currentChannelId: params.to,
        accountId: params.accountId,
        sessionKey: params.session?.key,
        agentId: params.session?.agentId,
      },
      "message-edit",
    ),
  );
  const edit = createStatusFooterMessageEditor(params, channelId);
  const shouldDecorate = (payload: ReplyPayload | undefined): payload is ReplyPayload =>
    enabled && isStatusFooterEligiblePayload(payload);
  const sendText = async (
    payload: ReplyPayload | undefined,
    isLast: boolean,
    unit: { text: string; overrides: OutboundMessageSendOverrides },
    send: StatusFooterTextHandler["sendText"],
  ): Promise<OutboundDeliveryResult> => {
    if (!isLast || !shouldDecorate(payload)) {
      return await send(unit.text, unit.overrides);
    }
    return await decorateIntermediate({
      conversationKey,
      mode,
      runId: context?.runId,
      textWithoutFooter: unit.text,
      send: async (text) => await send(text, unit.overrides),
      getMessageId: resolveDeliveryMessageId,
      edit,
      escapeHtml: params.formatting?.parseMode === "HTML",
    });
  };

  return {
    noteActivity(payload: ReplyPayload): void {
      if (
        enabled &&
        mode === "activity" &&
        context?.kind === "tool" &&
        payload.text &&
        isStatusFooterEligiblePayload(payload)
      ) {
        noteActivity(conversationKey, payload.text, context.runId);
      }
    },
    createTextChunkSender(options: {
      chunkMode: ChunkMode;
      formatting?: OutboundDeliveryFormattingOptions;
      abortSignal?: AbortSignal;
      consumeReplyTo: <T extends OutboundMessageSendOverrides>(overrides: T) => T;
      recordDelivery: (delivery: OutboundDeliveryResult) => Promise<void>;
    }) {
      return async (
        handler: StatusFooterTextHandler,
        text: string,
        overrides: OutboundMessageSendOverrides = {},
        payload?: ReplyPayload,
      ): Promise<void> => {
        const units = planOutboundTextMessageUnits({
          text,
          overrides,
          chunker: handler.chunker,
          chunkerMode: handler.chunkerMode,
          chunkedTextFormatting: handler.chunkedTextFormatting,
          textLimit:
            shouldDecorate(payload) && textLimit !== undefined
              ? textLimit - STATUS_FOOTER_MAX_RENDERED_CHARS
              : textLimit,
          chunkMode: options.chunkMode,
          formatting: options.formatting,
          consumeReplyTo: options.consumeReplyTo,
        });
        for (const [index, unit] of units.entries()) {
          if (unit.kind !== "text") {
            continue;
          }
          throwIfAborted(options.abortSignal);
          const delivery = await sendText(
            payload,
            index === units.length - 1,
            unit,
            handler.sendText,
          );
          await options.recordDelivery(delivery);
        }
      };
    },
  };
}
