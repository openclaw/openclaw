import type {
  ChannelOutboundAdapter,
  ChannelOutboundPayloadContext,
} from "../channels/plugins/types.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";

function buildSendFinal(
  outbound: ChannelOutboundAdapter,
): ((ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>) | undefined {
  if (outbound.sendFinal) {
    return outbound.sendFinal;
  }
  if (outbound.sendPayload) {
    return async (ctx) => await outbound.sendPayload!(ctx);
  }
  if (outbound.sendText && outbound.sendMedia) {
    return async (ctx) => {
      const media =
        ctx.payload.mediaUrl ??
        (Array.isArray(ctx.payload.mediaUrls) && ctx.payload.mediaUrls.length > 0
          ? ctx.payload.mediaUrls[0]
          : undefined);
      if (media) {
        return await outbound.sendMedia!({
          ...ctx,
          text: ctx.payload.text ?? ctx.text,
          mediaUrl: media,
          replyToId: ctx.payload.replyToId ?? ctx.replyToId,
        });
      }
      return await outbound.sendText!({
        ...ctx,
        text: ctx.payload.text ?? ctx.text,
        replyToId: ctx.payload.replyToId ?? ctx.replyToId,
      });
    };
  }
  return undefined;
}

/**
 * Build an outbound adapter that works with both legacy (v1) and durable (v2) hosts.
 * Existing sendText/sendMedia/sendPayload implementations continue to work unchanged.
 */
export function createCompatOutboundAdapter(
  outbound: ChannelOutboundAdapter,
): ChannelOutboundAdapter {
  const sendFinal = buildSendFinal(outbound);
  if (!sendFinal) {
    return outbound;
  }
  return {
    ...outbound,
    outboundContract: "v2",
    sendFinal,
  };
}
