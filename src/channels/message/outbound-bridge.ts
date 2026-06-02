import { createMessageReceiptFromOutboundResults } from "./receipt.js";
import type {
  ChannelMessageAdapterShape,
  ChannelMessageLiveAdapterShape,
  ChannelMessageReceiveAdapterShape,
  ChannelMessageSendMediaContext,
  ChannelMessageSendPayloadContext,
  ChannelMessageSendPollContext,
  ChannelMessageSendResult,
  ChannelMessageSendTextContext,
  DurableFinalDeliveryRequirementMap,
  MessageReceipt,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
} from "./types.js";

const defaultManualReceiveAdapter = {
  defaultAckPolicy: "manual",
  supportedAckPolicies: ["manual"],
} as const satisfies ChannelMessageReceiveAdapterShape;

/** Legacy send result accepted by outbound bridge methods before receipt normalization. */
export type ChannelMessageOutboundBridgeResult = MessageReceiptSourceResult & {
  /** Already-normalized receipt from adapters that can describe multipart sends themselves. */
  receipt?: MessageReceipt;
  /** Adapter-level id retained for older callers that do not return a full receipt. */
  messageId?: string;
};

/** Legacy outbound adapter shape bridged into the channel message adapter contract. */
export type ChannelMessageOutboundBridgeAdapter<TConfig = unknown> = {
  /** Durable final-send capabilities declared by older outbound implementations. */
  deliveryCapabilities?: {
    durableFinal?: DurableFinalDeliveryRequirementMap;
  };
  /** Text-only send hook used when the channel exposes a narrow text API. */
  sendText?: (
    ctx: ChannelMessageSendTextContext<TConfig>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
  /** Media send hook used for file/image/audio sends with optional caption text. */
  sendMedia?: (
    ctx: ChannelMessageSendMediaContext<TConfig>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
  /** Structured payload hook used by channels that consume rich reply payloads directly. */
  sendPayload?: (
    ctx: ChannelMessageSendPayloadContext<TConfig>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
  /** Poll send hook used when the platform has a native poll endpoint. */
  sendPoll?: (
    ctx: ChannelMessageSendPollContext<TConfig>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
};

/** Options for building a message adapter from legacy outbound send functions. */
export type CreateChannelMessageAdapterFromOutboundParams<TConfig = unknown> = {
  /** Stable adapter id surfaced through channel message capability listings. */
  id?: string;
  /** Legacy outbound implementation to wrap. */
  outbound: ChannelMessageOutboundBridgeAdapter<TConfig>;
  /** Capability override when wrapper ownership, not legacy outbound, declares guarantees. */
  capabilities?: DurableFinalDeliveryRequirementMap;
  /** Optional live-preview adapter metadata to preserve on the wrapped shape. */
  live?: ChannelMessageLiveAdapterShape;
  /** Optional receive adapter metadata; defaults to manual ack ownership for legacy sends. */
  receive?: ChannelMessageReceiveAdapterShape;
};

function resolveResultMessageId(result: ChannelMessageOutboundBridgeResult): string | undefined {
  // Prefer explicit and normalized receipt ids before provider-specific ids so follow-up edits
  // target the same primary platform message that receipt normalization selected.
  return (
    result.messageId ??
    result.receipt?.primaryPlatformMessageId ??
    result.receipt?.platformMessageIds[0] ??
    result.chatId ??
    result.channelId ??
    result.roomId ??
    result.conversationId ??
    result.toJid ??
    result.pollId
  );
}

function toMessageSendResult(
  result: ChannelMessageOutboundBridgeResult,
  params: {
    kind: MessageReceiptPartKind;
    normalizeReceiptKind?: boolean;
    threadId?: string | number | null;
    replyToId?: string | null;
  },
): ChannelMessageSendResult {
  // Poll APIs often return card-like receipts from older senders; normalize the part kind so
  // durable capability checks and recovery classify the message by the API that sent it.
  const receipt = result.receipt
    ? params.normalizeReceiptKind
      ? {
          ...result.receipt,
          parts: result.receipt.parts.map((part) => ({ ...part, kind: params.kind })),
        }
      : result.receipt
    : createMessageReceiptFromOutboundResults({
        results: [result],
        kind: params.kind,
        threadId: params.threadId == null ? undefined : String(params.threadId),
        replyToId: params.replyToId ?? undefined,
      });
  return {
    receipt,
    ...(resolveResultMessageId({ ...result, receipt })
      ? {
          messageId: resolveResultMessageId({ ...result, receipt }),
        }
      : {}),
  };
}

function resolvePayloadReceiptKind(
  ctx: ChannelMessageSendPayloadContext<unknown>,
): MessageReceiptPartKind {
  // Structured payload sends can collapse multiple content shapes into one hook; preserve the
  // most specific durable-recovery kind rather than treating every payload as a generic card.
  if (
    ctx.payload.audioAsVoice &&
    (ctx.mediaUrl || ctx.payload.mediaUrl || ctx.payload.mediaUrls?.length)
  ) {
    return "voice";
  }
  if (ctx.mediaUrl || ctx.payload.mediaUrl || ctx.payload.mediaUrls?.length) {
    return "media";
  }
  if (ctx.payload.text?.trim() || ctx.text.trim()) {
    return "text";
  }
  if (ctx.payload.presentation?.blocks?.length || ctx.payload.interactive) {
    return "card";
  }
  return "unknown";
}

/** Converts legacy outbound send methods into a typed channel message adapter. */
export function createChannelMessageAdapterFromOutbound<TConfig = unknown>(
  params: CreateChannelMessageAdapterFromOutboundParams<TConfig>,
): ChannelMessageAdapterShape<TConfig> {
  const send: NonNullable<ChannelMessageAdapterShape<TConfig>["send"]> = {};
  if (params.outbound.sendText) {
    send.text = async (ctx) =>
      toMessageSendResult(await params.outbound.sendText!(ctx), {
        kind: "text",
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
  }
  if (params.outbound.sendMedia) {
    send.media = async (ctx) =>
      toMessageSendResult(await params.outbound.sendMedia!(ctx), {
        kind: ctx.audioAsVoice ? "voice" : "media",
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
  }
  if (params.outbound.sendPayload) {
    send.payload = async (ctx) =>
      toMessageSendResult(await params.outbound.sendPayload!(ctx), {
        kind: resolvePayloadReceiptKind(ctx as ChannelMessageSendPayloadContext<unknown>),
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
  }
  if (params.outbound.sendPoll) {
    send.poll = async (ctx) =>
      toMessageSendResult(await params.outbound.sendPoll!(ctx), {
        kind: "poll",
        normalizeReceiptKind: true,
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
  }

  return {
    ...(params.id ? { id: params.id } : {}),
    durableFinal: {
      capabilities: params.capabilities ?? params.outbound.deliveryCapabilities?.durableFinal,
    },
    send,
    ...(params.live ? { live: params.live } : {}),
    receive: params.receive ?? defaultManualReceiveAdapter,
  };
}
