import type { ChannelOutboundAdapter, ChannelOutboundContext } from "../types.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { sendDiscordWebhook } from "../../../discord/send.webhook.js";

/**
 * Resolve Discord webhook configuration for an agent.
 * Returns the webhook URL and optional settings if configured.
 */
function resolveAgentWebhook(ctx: ChannelOutboundContext): {
  webhookUrl: string;
  username: string;
  avatarUrl?: string;
} | null {
  const { cfg, agentId } = ctx;
  if (!agentId) return null;

  const agent = cfg.agents?.list?.find((a) => a.id === agentId);
  const webhookUrl = agent?.discord?.responseWebhook;
  if (!webhookUrl) return null;

  const username = agent.name ?? agent.id;

  return {
    webhookUrl,
    username,
    avatarUrl: agent.discord?.responseWebhookAvatar,
  };
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  sendText: async (ctx) => {
    const { to, text, accountId, deps, replyToId } = ctx;

    // Check for agent webhook routing
    const webhook = resolveAgentWebhook(ctx);
    if (webhook) {
      const result = await sendDiscordWebhook(webhook.webhookUrl, text, {
        username: webhook.username,
        avatarUrl: webhook.avatarUrl,
        replyTo: replyToId ?? undefined,
      });
      return { channel: "discord", ...result };
    }

    // Fall back to bot send
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async (ctx) => {
    const { to, text, mediaUrl, accountId, deps, replyToId } = ctx;

    // Check for agent webhook routing
    const webhook = resolveAgentWebhook(ctx);
    if (webhook) {
      const result = await sendDiscordWebhook(webhook.webhookUrl, text, {
        username: webhook.username,
        avatarUrl: webhook.avatarUrl,
        mediaUrl,
        replyTo: replyToId ?? undefined,
      });
      return { channel: "discord", ...result };
    }

    // Fall back to bot send
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
