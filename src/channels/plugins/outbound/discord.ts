import type { ChannelOutboundAdapter } from "../types.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { missingTargetError } from "../../../infra/outbound/target-errors.js";
import { normalizeDiscordMessagingTarget } from "../normalize/discord.js";

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  resolveTarget: ({ to, allowFrom, mode }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      if (mode === "implicit" || mode === "heartbeat") {
        const fallback = (allowFrom ?? []).map((e) => String(e).trim()).filter(Boolean)[0];
        if (fallback) {
          const normalized = normalizeDiscordMessagingTarget(fallback);
          if (normalized) {
            return { ok: true, to: normalized };
          }
        }
      }
      return {
        ok: false,
        error: missingTargetError("Discord", "<channelId|user:ID|channel:ID>"),
      };
    }
    const normalized = normalizeDiscordMessagingTarget(trimmed);
    if (normalized) {
      return { ok: true, to: normalized };
    }
    return {
      ok: false,
      error: new Error(
        `Invalid Discord target "${trimmed}". Use channel:<id> for channels or user:<id> for DMs.`,
      ),
    };
  },
  sendText: async ({ to, text, accountId, deps, replyToId }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
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
