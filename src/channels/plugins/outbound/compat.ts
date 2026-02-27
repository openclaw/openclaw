import type { OutboundDeliveryResult } from "../../../infra/outbound/deliver.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContractVersion,
  ChannelOutboundPayloadContext,
} from "../types.js";

const warnedLegacyChannels = new Set<string>();

export type NormalizedChannelOutboundAdapter = ChannelOutboundAdapter & {
  outboundContract: "v2";
  sendFinal: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
};

export type OutboundAdapterNormalization = {
  adapter: NormalizedChannelOutboundAdapter;
  contract: ChannelOutboundContractVersion;
  supportsIdempotencyKey: boolean;
};

export function resolveOutboundContractVersion(
  adapter: ChannelOutboundAdapter | undefined,
): ChannelOutboundContractVersion | undefined {
  if (!adapter) {
    return undefined;
  }
  if (adapter.sendFinal || adapter.outboundContract === "v2") {
    return "v2";
  }
  if (adapter.sendPayload || (adapter.sendText && adapter.sendMedia)) {
    return "v1";
  }
  return undefined;
}

function inferSendFinal(
  adapter: ChannelOutboundAdapter,
): NormalizedChannelOutboundAdapter["sendFinal"] | undefined {
  if (adapter.sendFinal) {
    return adapter.sendFinal;
  }
  if (adapter.sendPayload) {
    return async (ctx) => await adapter.sendPayload!(ctx);
  }
  if (adapter.sendText && adapter.sendMedia) {
    return async (ctx) => {
      const media =
        ctx.payload.mediaUrl ??
        (Array.isArray(ctx.payload.mediaUrls) && ctx.payload.mediaUrls.length > 0
          ? ctx.payload.mediaUrls[0]
          : undefined);
      if (media) {
        return await adapter.sendMedia!({
          ...ctx,
          text: ctx.payload.text ?? ctx.text,
          mediaUrl: media,
          replyToId: ctx.payload.replyToId ?? ctx.replyToId,
        });
      }
      return await adapter.sendText!({
        ...ctx,
        text: ctx.payload.text ?? ctx.text,
        replyToId: ctx.payload.replyToId ?? ctx.replyToId,
      });
    };
  }
  return undefined;
}

export function normalizeChannelOutboundAdapter(params: {
  channelId: string;
  adapter?: ChannelOutboundAdapter;
  warnLegacy?: (msg: string) => void;
}): OutboundAdapterNormalization | undefined {
  const outbound = params.adapter;
  if (!outbound) {
    return undefined;
  }

  const sendFinal = inferSendFinal(outbound);
  if (!sendFinal) {
    return undefined;
  }

  const declaredContract = outbound.outboundContract === "v2" ? "v2" : "v1";
  const contract: ChannelOutboundContractVersion = outbound.sendFinal ? "v2" : declaredContract;

  if (contract === "v1" && params.warnLegacy && !warnedLegacyChannels.has(params.channelId)) {
    warnedLegacyChannels.add(params.channelId);
    params.warnLegacy(
      `[${params.channelId}] outbound adapter is using v1 compatibility mode; add outboundContract="v2" + sendFinal() for full durable semantics.`,
    );
  }

  const normalized: NormalizedChannelOutboundAdapter = {
    ...outbound,
    outboundContract: "v2",
    sendFinal,
  };

  return {
    adapter: normalized,
    contract,
    supportsIdempotencyKey: outbound.supportsIdempotencyKey === true,
  };
}

export function resetOutboundCompatWarningsForTest(): void {
  warnedLegacyChannels.clear();
}
