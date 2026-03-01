import type { OutboundIdentity } from "../../../infra/outbound/identity.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { sendMessageSlack, type SlackSendIdentity } from "../../../slack/send.js";

function resolveSlackSendIdentity(identity?: OutboundIdentity): SlackSendIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const username = identity.name?.trim() || undefined;
  const iconUrl = identity.avatarUrl?.trim() || undefined;
  const rawEmoji = identity.emoji?.trim();
  const iconEmoji = !iconUrl && rawEmoji && /^:[^:\s]+:$/.test(rawEmoji) ? rawEmoji : undefined;
  if (!username && !iconUrl && !iconEmoji) {
    return undefined;
  }
  return { username, iconUrl, iconEmoji };
}

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 4000,
  sendText: async ({ to, text, accountId, deps, replyToId, threadId, identity }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    // Use threadId fallback so routed tool notifications stay in the Slack thread.
    const threadTs = replyToId ?? (threadId != null ? String(threadId) : undefined);
    let finalText = text;

    // Run message_sending hooks (e.g. thread-ownership can cancel the send).
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("message_sending")) {
      const hookResult = await hookRunner.runMessageSending(
        { to, content: text, metadata: { threadTs, channelId: to } },
        { channelId: "slack", accountId: accountId ?? undefined },
      );
      if (hookResult?.cancel) {
        return {
          channel: "slack",
          messageId: "cancelled-by-hook",
          channelId: to,
          meta: { cancelled: true },
        };
      }
      if (hookResult?.content) {
        finalText = hookResult.content;
      }
    }

    const slackIdentity = resolveSlackSendIdentity(identity);
    const result = await send(to, finalText, {
      threadTs,
      accountId: accountId ?? undefined,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    return { channel: "slack", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId, threadId, identity }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    // Use threadId fallback so routed tool notifications stay in the Slack thread.
    const threadTs = replyToId ?? (threadId != null ? String(threadId) : undefined);
    let finalText = text;

    // Run message_sending hooks (e.g. thread-ownership can cancel the send).
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("message_sending")) {
      const hookResult = await hookRunner.runMessageSending(
        { to, content: text, metadata: { threadTs, channelId: to, mediaUrl } },
        { channelId: "slack", accountId: accountId ?? undefined },
      );
      if (hookResult?.cancel) {
        return {
          channel: "slack",
          messageId: "cancelled-by-hook",
          channelId: to,
          meta: { cancelled: true },
        };
      }
      if (hookResult?.content) {
        finalText = hookResult.content;
      }
    }

    const slackIdentity = resolveSlackSendIdentity(identity);
    const result = await send(to, finalText, {
      mediaUrl,
      threadTs,
      accountId: accountId ?? undefined,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    return { channel: "slack", ...result };
  },
};
