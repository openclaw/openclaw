import type { ChatReplyTarget } from "../../../lib/chat/chat-types.ts";
import type { AnswerLensSource } from "../answer-lens.ts";
import type { AssistantMessageExpansionState } from "../chat-message-recovery.ts";

export type MessageReplyTarget = ChatReplyTarget;

export type MessageActionDetails = {
  answerLensSource?: AnswerLensSource;
  /** Source for context copy, independent of footer visibility and reply truncation. */
  copyMarkdown?: string;
  markdown?: string;
  readAloudText?: string;
  fullMessage?: { messageId: string; state: AssistantMessageExpansionState | undefined };
  replyTarget?: MessageReplyTarget;
  reactionMessageId?: string;
};
