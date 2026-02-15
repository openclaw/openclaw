import type { WebClient } from "@slack/web-api";
import type { SummarizePeriod, SummarizeResult } from "./types.js";
import { resolveChannelId, resolveUserName } from "./resolve.js";

type HistoryResponse = {
  messages?: Array<{
    ts?: string;
    text?: string;
    user?: string;
  }>;
  has_more?: boolean;
};

export type SummarizeReaderOptions = {
  channel: string;
  period: SummarizePeriod;
};

function resolvePeriodTimestamp(period: SummarizePeriod): string {
  const now = new Date();
  let start: Date;
  switch (period) {
    case "today": {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    }
    case "yesterday": {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      break;
    }
    case "this_week": {
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
      break;
    }
    case "this_month": {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    }
    default:
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  return String(start.getTime() / 1000);
}

export async function summarizeReaderChannel(
  client: WebClient,
  options: SummarizeReaderOptions,
): Promise<SummarizeResult> {
  const channelId = await resolveChannelId(client, options.channel);
  const oldest = resolvePeriodTimestamp(options.period);

  const res = (await client.conversations.history({
    channel: channelId,
    oldest,
    limit: 100,
  })) as HistoryResponse;

  const rawMessages = res.messages ?? [];
  if (rawMessages.length === 0) {
    return { messages: [], formatted: "", empty: true };
  }

  const messages: SummarizeResult["messages"] = [];
  const lines: string[] = [];

  for (const msg of rawMessages) {
    const ts = msg.ts ?? "";
    const text = msg.text ?? "";
    const authorId = msg.user ?? "";
    const author = await resolveUserName(client, authorId);
    messages.push({ ts, text, author });
    lines.push(`${author}: ${text}`);
  }

  return {
    messages,
    formatted: lines.join("\n"),
    empty: false,
  };
}
