import type { Guild, Message, User } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { resolveTimestampMs } from "./format.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";

export type DiscordReplyContext = {
  id: string;
  channelId: string;
  sender: string;
  body: string;
  timestamp?: number;
};

export async function resolveReplyContext(
  message: Message,
  resolveDiscordMessageText: (message: Message, options?: { includeForwarded?: boolean }) => string,
  client?: { rest: { get: (path: string) => Promise<unknown> } },
): Promise<DiscordReplyContext | null> {
  const referenced = message.referencedMessage;
  if (!referenced?.author) {
    return null;
  }
  let referencedText = resolveDiscordMessageText(referenced, {
    includeForwarded: true,
  });

  // Gateway partial: content empty but message exists — fetch full via REST
  if (!referencedText && referenced.id && referenced.channelId && client) {
    try {
      const full = (await client.rest.get(
        Routes.channelMessage(referenced.channelId, referenced.id),
      )) as { content?: string };
      if (full?.content) {
        referencedText = full.content;
      }
    } catch {
      // Graceful degradation — no reply context rather than crashing
    }
  }

  if (!referencedText) {
    return null;
  }
  const sender = resolveDiscordSenderIdentity({
    author: referenced.author,
    pluralkitInfo: null,
  });
  return {
    id: referenced.id,
    channelId: referenced.channelId,
    sender: sender.tag ?? sender.label ?? "unknown",
    body: referencedText,
    timestamp: resolveTimestampMs(referenced.timestamp),
  };
}

export function buildDirectLabel(author: User, tagOverride?: string) {
  const username =
    tagOverride?.trim() || resolveDiscordSenderIdentity({ author, pluralkitInfo: null }).tag;
  return `${username ?? "unknown"} user id:${author.id}`;
}

export function buildGuildLabel(params: {
  guild?: Guild<true> | Guild;
  channelName: string;
  channelId: string;
}) {
  const { guild, channelName, channelId } = params;
  return `${guild?.name ?? "Guild"} #${channelName} channel id:${channelId}`;
}
