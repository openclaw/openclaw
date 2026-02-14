import type { ChannelOutboundAdapter } from "../types.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  sendText: async ({ to, text, accountId, deps, replyToId, silent }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId, silent }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ to, poll, accountId, silent }) =>
    await sendPollDiscord(to, poll, {
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    }),
};
