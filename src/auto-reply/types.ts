import type { TypingController } from "./reply/typing.js";

export type GetReplyOptions = {
  onReplyStart?: () => Promise<void> | void;
  onTypingController?: (typing: TypingController) => void;
  isHeartbeat?: boolean;
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
  onBlockReply?: (payload: ReplyPayload) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  disableBlockStreaming?: boolean;
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
};
