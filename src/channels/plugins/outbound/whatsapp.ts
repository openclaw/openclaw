import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import { resolveWhatsAppOutboundTarget } from "../../../whatsapp/resolve-outbound-target.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { buildWhatsAppRawSend } from "../mux-envelope.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  sendText: async ({ cfg, to, text, accountId, deps, gifPlayback, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "whatsapp", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "whatsapp",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        raw: {
          whatsapp: buildWhatsAppRawSend({
            text,
            gifPlayback,
          }),
        },
      });
      return { channel: "whatsapp", ...result };
    }
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, gifPlayback, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "whatsapp", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "whatsapp",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        mediaUrl,
        raw: {
          whatsapp: buildWhatsAppRawSend({
            text,
            mediaUrl,
            gifPlayback,
          }),
        },
      });
      return { channel: "whatsapp", ...result };
    }
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
  sendPoll: async ({ cfg, to, poll, accountId }) => {
    if (isMuxEnabled({ cfg, channel: "whatsapp", accountId: accountId ?? undefined })) {
      throw new Error("whatsapp mux poll delivery requires sessionKey; use routed replies instead");
    }
    return await sendPollWhatsApp(to, poll, {
      verbose: shouldLogVerbose(),
      accountId: accountId ?? undefined,
    });
  },
};
