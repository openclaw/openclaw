import type { WebClient } from "@slack/web-api";
import type { SlackReaderMessage } from "./types.js";
import { resolveChannelId, resolveUserName } from "./resolve.js";

type RepliesResponse = {
  messages?: Array<{
    ts?: string;
    text?: string;
    user?: string;
    thread_ts?: string;
  }>;
  has_more?: boolean;
};

export type ReadReaderThreadOptions = {
  channel: string;
  threadTs: string;
};

export async function readReaderThread(
  client: WebClient,
  options: ReadReaderThreadOptions,
): Promise<SlackReaderMessage[]> {
  const channelId = await resolveChannelId(client, options.channel);

  const res = (await client.conversations.replies({
    channel: channelId,
    ts: options.threadTs,
  })) as RepliesResponse;

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
    });
  }
  return messages;
}
