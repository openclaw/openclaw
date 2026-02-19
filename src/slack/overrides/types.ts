export type SlackFile = {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

// Slack attachment for forwarded messages
export type SlackAttachment = {
  text?: string;
  fallback?: string;
  pretext?: string;
  title?: string;
  title_link?: string;
  author_name?: string;
  fields?: Array<{
    title?: string;
    value?: string;
    short?: boolean;
  }>;
  footer?: string;
  ts?: string;
};

export type SlackMessageEvent = {
  type: "message";
  user?: string;
  bot_id?: string;
  subtype?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  parent_user_id?: string;
  channel: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
  files?: SlackFile[];
  attachments?: SlackAttachment[];
};

export type SlackAppMentionEvent = {
  type: "app_mention";
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  parent_user_id?: string;
  channel: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
};
