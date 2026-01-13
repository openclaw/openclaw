import { chunkMarkdownText } from "../../../auto-reply/chunk.js";
import { sendMessageZalo } from "../../../zalo/send.js";
import type { ChannelOutboundAdapter } from "../types.js";

export const zaloOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkMarkdownText,
  textChunkLimit: 2000, // Zalo's message limit
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error("Delivering to Zalo requires --to <chatId>"),
      };
    }
    return { ok: true, to: trimmed };
  },
  sendText: async ({ to, text, accountId }) => {
    const result = await sendMessageZalo(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "zalo",
      ok: result.ok,
      messageId: result.messageId ?? "",
      error: result.error ? new Error(result.error) : undefined,
    };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId }) => {
    const result = await sendMessageZalo(to, text, {
      verbose: false,
      mediaUrl,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "zalo",
      ok: result.ok,
      messageId: result.messageId ?? "",
      error: result.error ? new Error(result.error) : undefined,
    };
  },
};
