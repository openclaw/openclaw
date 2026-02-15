import type { WebClient } from "@slack/web-api";
import type { SlackReaderChannel } from "./types.js";

type SlackChannelListResponse = {
  channels?: Array<{
    id?: string;
    name?: string;
    topic?: { value?: string };
    num_members?: number;
    is_archived?: boolean;
  }>;
  response_metadata?: { next_cursor?: string };
};

export async function listReaderChannels(client: WebClient): Promise<SlackReaderChannel[]> {
  const channels: SlackReaderChannel[] = [];
  let cursor: string | undefined;
  do {
    const res = (await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 1000,
      cursor,
    })) as SlackChannelListResponse;
    for (const ch of res.channels ?? []) {
      const id = ch.id?.trim();
      const name = ch.name?.trim();
      if (!id || !name) {
        continue;
      }
      channels.push({
        id,
        name,
        topic: ch.topic?.value?.trim() ?? "",
        memberCount: ch.num_members ?? 0,
      });
    }
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next || undefined;
  } while (cursor);
  return channels;
}
