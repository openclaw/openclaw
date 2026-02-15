import type { WebClient } from "@slack/web-api";
import type { SlackReaderMessage } from "./types.js";
import { clampCount, resolveChannelId, resolveUserName } from "./resolve.js";

type HistoryResponse = {
  messages?: Array<{
    ts?: string;
    text?: string;
    user?: string;
    thread_ts?: string;
    reply_count?: number;
  }>;
  has_more?: boolean;
};

export type ReadReaderHistoryOptions = {
  channel: string;
  count?: number;
  since?: string;
};

export async function readReaderHistory(
  client: WebClient,
  options: ReadReaderHistoryOptions,
): Promise<SlackReaderMessage[]> {
  const channelId = await resolveChannelId(client, options.channel);
  const limit = clampCount(options.count);
  const oldest = options.since ? String(new Date(options.since).getTime() / 1000) : undefined;

  const res = (await client.conversations.history({
    channel: channelId,
    limit,
    oldest,
  })) as HistoryResponse;

  const messages: SlackReaderMessage[] = [];
  for (const msg of res.messages ?? []) {
    const ts = msg.ts ?? "";
    const text = msg.text ?? "";
    const authorId = msg.user ?? "";
    const author = await resolveUserName(client, authorId);
    messages.push({
      ts,
      text,
      author,
      authorId,
      channel: options.channel.replace(/^#/, ""),
      channelId,
      threadTs: msg.thread_ts,
      replyCount: msg.reply_count,
    });
  }
  return messages;
}
