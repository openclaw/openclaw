import { resolveGoogleChatAccount } from "../../../googlechat/accounts.js";
import {
  chunkGoogleChatText,
  sendGoogleChatMedia,
  sendGoogleChatText,
} from "../../../googlechat/send.js";
import type { ProviderOutboundAdapter } from "../types.js";

export const googlechatOutbound: ProviderOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkGoogleChatText,
  textChunkLimit: 4000,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error("Delivering to Google Chat requires --to <spaceId>"),
      };
    }
    return { ok: true, to: trimmed };
  },
  sendText: async ({ to, text, accountId, cfg, replyToId }) => {
    const account = resolveGoogleChatAccount({ cfg, accountId });
    const result = await sendGoogleChatText(to, text, {
      account,
      threadKey: replyToId ?? undefined,
    });
    return { provider: "googlechat", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, cfg, replyToId }) => {
    const account = resolveGoogleChatAccount({ cfg, accountId });
    const result = await sendGoogleChatMedia(to, mediaUrl ?? "", {
      account,
      caption: text,
      threadKey: replyToId ?? undefined,
    });
    return { provider: "googlechat", ...result };
  },
};
