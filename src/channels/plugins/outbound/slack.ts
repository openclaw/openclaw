import { sendMessageSlack } from "../../../slack/send.js";
import type { ChannelOutboundAdapter } from "../types.js";

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 4000,
  sendText: async ({ to, text, accountId, deps, replyToId }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    const result = await send(to, text, {
      threadTs: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "slack", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    const result = await send(to, text, {
      mediaUrl,
      threadTs: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "slack", ...result };
  },
};
