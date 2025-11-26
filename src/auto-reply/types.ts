export type GetReplyOptions = {
  onReplyStart?: () => Promise<void> | void;
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};
