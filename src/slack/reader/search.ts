import type { WebClient } from "@slack/web-api";
import type { SlackReaderMessage } from "./types.js";

type SearchMatch = {
  ts?: string;
  text?: string;
  user?: string;
  username?: string;
  channel?: { id?: string; name?: string };
  permalink?: string;
};

type SearchResponse = {
  messages?: {
    matches?: SearchMatch[];
    total?: number;
  };
};

export type SearchReaderOptions = {
  clients: Record<string, WebClient>;
  workspace: string;
  query: string;
  count: number;
};

async function searchSingleWorkspace(
  client: WebClient,
  query: string,
  count: number,
  workspace: string,
): Promise<SlackReaderMessage[]> {
  const res = (await client.search.messages({
    query,
    count,
  })) as SearchResponse;

  const matches = res.messages?.matches ?? [];
  return matches.map((match) => ({
    ts: match.ts ?? "",
    text: match.text ?? "",
    author: match.username ?? "Unknown",
    authorId: match.user ?? "",
    channel: match.channel?.name ?? "",
    channelId: match.channel?.id ?? "",
    workspace,
    permalink: match.permalink,
  }));
}

export async function searchReaderMessages(
  options: SearchReaderOptions,
): Promise<SlackReaderMessage[]> {
  const { clients, workspace, query, count } = options;

  if (workspace === "all") {
    const results: SlackReaderMessage[] = [];
    const entries = Object.entries(clients);
    const searches = entries.map(([ws, client]) => searchSingleWorkspace(client, query, count, ws));
    const allResults = await Promise.all(searches);
    for (const wsResults of allResults) {
      results.push(...wsResults);
    }
    return results;
  }

  const client = clients[workspace];
  if (!client) {
    return [];
  }
  return searchSingleWorkspace(client, query, count, workspace);
}
