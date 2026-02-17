import type { ChannelOutboundAdapter } from "../types.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { normalizeDiscordOutboundTarget } from "../normalize/discord.js";

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
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
  sendMedia: async ({
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    silent,
  }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
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
