/** A conversational observation, never a command, approval, or task disposition. */
export type ChannelReactionContext = {
  channel: string;
  accountId: string;
  conversationId: string;
  actorId: string;
  /** Transport occurrence identity, not the identity of the reacted-to message. */
  occurrenceId: string;
  action: "added" | "removed";
  emoji: string;
  target: {
    messageId: string;
    authorId?: string;
    /** Bounded original content, only when the channel's context policy permits it. */
    body?: string;
  };
};
