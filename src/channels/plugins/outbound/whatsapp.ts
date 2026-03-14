import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { createWhatsAppOutboundBase } from "../whatsapp-shared.js";
import { sendTextMediaPayload } from "./direct-text-media.js";

function trimLeadingWhitespace(text: string | undefined): string {
  return text?.trimStart() ?? "";
}

export const whatsappOutbound: ChannelOutboundAdapter = {
  ...createWhatsAppOutboundBase({
    chunker: chunkText,
    sendMessageWhatsApp: async (...args) =>
      (await import("../../../web/outbound.js")).sendMessageWhatsApp(...args),
    sendPollWhatsApp,
    shouldLogVerbose,
    normalizeText: trimLeadingWhitespace,
    skipEmptyText: true,
  }),
  sendPayload: async (ctx) => {
    const text = trimLeadingWhitespace(ctx.payload.text);
    const hasMedia = Boolean(ctx.payload.mediaUrl) || (ctx.payload.mediaUrls?.length ?? 0) > 0;
    if (!text && !hasMedia) {
      return { channel: "whatsapp", messageId: "" };
    }
    return await sendTextMediaPayload({
      channel: "whatsapp",
      ctx: {
        ...ctx,
        payload: {
          ...ctx.payload,
          text,
        },
      },
      adapter: whatsappOutbound,
    });
  },
};
