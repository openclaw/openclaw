import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { normalizeDiscordOutboundTarget } from "../normalize/discord.js";
import { buildDiscordRawSend } from "../mux-envelope.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, silent, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "discord", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "discord",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        replyToId,
        raw: {
          discord: buildDiscordRawSend({
            text,
            replyToId,
          }),
        },
      });
      return { channel: "discord", ...result };
    }
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, replyToId, silent, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "discord", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "discord",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        mediaUrl,
        replyToId,
        raw: {
          discord: buildDiscordRawSend({
            text,
            mediaUrl,
            replyToId,
          }),
        },
      });
      return { channel: "discord", ...result };
    }
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
  sendPoll: async ({ cfg, to, poll, accountId, silent }) => {
    if (isMuxEnabled({ cfg, channel: "discord", accountId: accountId ?? undefined })) {
      throw new Error("discord mux poll delivery requires sessionKey; use routed replies instead");
    }
    return await sendPollDiscord(to, poll, {
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
  },
};
