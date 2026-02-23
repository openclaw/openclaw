import type { OpenClawConfig } from "../../../config/config.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { resolveDiscordAccount } from "../../../discord/accounts.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { convertTimesToDiscordTimestamps } from "../../../discord/timestamps.js";

function applyTimestamps(text: string, cfg: OpenClawConfig, accountId?: string | null): string {
  const { config } = resolveDiscordAccount({ cfg, accountId });
  if (config.discordTimestamps !== false) {
    return convertTimesToDiscordTimestamps(text);
  }
  return text;
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, applyTimestamps(text, cfg, accountId), {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps, replyToId }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, applyTimestamps(text, cfg, accountId), {
      verbose: false,
      mediaUrl,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ to, poll, accountId }) =>
    await sendPollDiscord(to, poll, {
      accountId: accountId ?? undefined,
    }),
};
