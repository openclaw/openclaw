import {
  getChannelPlugin,
  normalizeChannelId as normalizeAnyChannelId,
} from "../../channels/plugins/index.js";
import { resolveSessionConversationRef } from "../../channels/plugins/session-conversation.js";
import { normalizeChannelId as normalizeChatChannelId } from "../../channels/registry.js";

export {
  ANNOUNCE_SKIP_TOKEN,
  REPLY_SKIP_TOKEN,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-tokens.js";

export {
  buildAgentToAgentMessageContext,
  buildAgentToAgentReplyContext,
  buildAgentToAgentAnnounceContext,
  resolvePingPongTurns,
} from "./sessions-send-a2a-helpers.js";

export type AnnounceTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string; // Forum topic/thread ID
};

export function resolveAnnounceTargetFromKey(sessionKey: string): AnnounceTarget | null {
  const parsed = resolveSessionConversationRef(sessionKey);
  if (!parsed) {
    return null;
  }
  const normalizedChannel =
    normalizeAnyChannelId(parsed.channel) ?? normalizeChatChannelId(parsed.channel);
  const channel = normalizedChannel ?? parsed.channel;
  const plugin = normalizedChannel ? getChannelPlugin(normalizedChannel) : null;
  const genericTarget = parsed.kind === "channel" ? `channel:${parsed.id}` : `group:${parsed.id}`;
  const normalized =
    plugin?.messaging?.resolveSessionTarget?.({
      kind: parsed.kind,
      id: parsed.id,
      threadId: parsed.threadId,
    }) ?? plugin?.messaging?.normalizeTarget?.(genericTarget);
  return {
    channel,
    to: normalized ?? (normalizedChannel ? genericTarget : parsed.id),
    threadId: parsed.threadId,
  };
}

export function buildAgentSessionLines(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
}): string[] {
  return [
    params.requesterSessionKey
      ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterChannel
      ? `Agent 1 (requester) channel: ${params.requesterChannel}.`
      : undefined,
    `Agent 2 (target) session: ${params.targetSessionKey}.`,
    params.targetChannel ? `Agent 2 (target) channel: ${params.targetChannel}.` : undefined,
  ].filter((line): line is string => Boolean(line));
}
