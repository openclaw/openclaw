import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import { resolveWhatsAppOutboundTarget } from "../../../whatsapp/resolve-outbound-target.js";
import type { ChannelOutboundAdapter } from "../types.js";

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  sendPayload: async (ctx) => {
    const text = ctx.payload.text ?? "";
    const urls = ctx.payload.mediaUrls?.length
      ? ctx.payload.mediaUrls
      : ctx.payload.mediaUrl
        ? [ctx.payload.mediaUrl]
        : [];
    if (!text && urls.length === 0) {
      return { channel: "whatsapp", messageId: "" };
    }
    if (urls.length > 0) {
      let lastResult = await whatsappOutbound.sendMedia!({
        ...ctx,
        text,
        mediaUrl: urls[0],
      });
      for (let i = 1; i < urls.length; i++) {
        lastResult = await whatsappOutbound.sendMedia!({
          ...ctx,
          text: "",
          mediaUrl: urls[i],
        });
      }
      return lastResult;
    }
    const limit = whatsappOutbound.textChunkLimit;
    const chunks =
      limit && whatsappOutbound.chunker ? whatsappOutbound.chunker(text, limit) : [text];
    let lastResult: Awaited<ReturnType<NonNullable<typeof whatsappOutbound.sendText>>>;
    for (const chunk of chunks) {
      lastResult = await whatsappOutbound.sendText!({ ...ctx, text: chunk });
    }
    return lastResult!;
  },
  sendText: async ({ to, text, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, mediaLocalRoots, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendPoll: async ({ to, poll, accountId }) =>
    await sendPollWhatsApp(to, poll, {
      verbose: shouldLogVerbose(),
      accountId: accountId ?? undefined,
    }),
};
