// Reply-preview types, kept in a leaf module so the chat message graph can name
// them without importing the resolver in chat-reply-preview.ts.
import type { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import type { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { MessageReplyTarget } from "./chat-message-markdown.ts";

export type ReplyPreview = MessageReplyTarget & {
  sourceMessageId: string;
  sender?: ReturnType<typeof normalizeMessage>["sender"];
  /** The run a source prompt started, from its persisted user-turn identity. */
  turnRunId?: string;
  agentAvatar?: Parameters<typeof renderChatAuthorAvatar>[2];
};

/** A lookup answered without a message (see ReplyMessageStatus in chat-reply-preview.ts). */
type ReplyStatusPreview = { pending: true } | { missing: true } | { oversized: true };

export type ReplyPreviewLookup = (
  replyToId: string,
) => ReplyPreview | ReplyStatusPreview | undefined;
