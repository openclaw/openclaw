import type { ChannelOutboundAdapter } from "../types.js";
import { resolveSlackPersona } from "../../../slack/persona.js";
import { sendMessageSlack } from "../../../slack/send.js";

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 4000,
  sendText: async ({ to, text, accountId, agentId, deps, replyToId, threadId, cfg }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    // Use threadId fallback so routed tool notifications stay in the Slack thread.
    const threadTs = replyToId ?? (threadId != null ? String(threadId) : undefined);
    const persona = resolveSlackPersona(cfg, agentId);
    const result = await send(to, text, {
      threadTs,
      accountId: accountId ?? undefined,
      persona,
    });
    return { channel: "slack", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, agentId, deps, replyToId, threadId, cfg }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    // Use threadId fallback so routed tool notifications stay in the Slack thread.
    const threadTs = replyToId ?? (threadId != null ? String(threadId) : undefined);
    const persona = resolveSlackPersona(cfg, agentId);
    const result = await send(to, text, {
      mediaUrl,
      threadTs,
      accountId: accountId ?? undefined,
      persona,
    });
    return { channel: "slack", ...result };
  },
};
