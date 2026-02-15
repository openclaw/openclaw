export type SlackReaderMessage = {
  ts: string;
  text: string;
  author: string;
  authorId: string;
  channel: string;
  channelId: string;
  threadTs?: string;
  replyCount?: number;
  workspace?: string;
  permalink?: string;
};

export type SlackReaderChannel = {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
};

export type SlackReaderConfig = {
  enabled?: boolean;
  workspaces?: Record<
    string,
    {
      botToken?: string;
      name?: string;
      enabled?: boolean;
    }
  >;
  maxCount?: number;
};

export type SummarizePeriod = "today" | "yesterday" | "this_week" | "this_month";

export type SummarizeResult = {
  messages: Array<{ ts: string; text: string; author: string }>;
  formatted: string;
  empty: boolean;
};
