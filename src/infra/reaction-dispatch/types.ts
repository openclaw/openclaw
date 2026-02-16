export type ReactionEventItem = {
  emoji: string;
  actorLabel: string;
  actorId?: string;
  action: "added" | "removed";
  ts: number;
};

export type ReactionBundleContext = {
  channel: string; // discord, telegram, slack, signal, imessage, bluebubbles
  accountId: string;
  sessionKey: string;
  messageId: string;
  reactions: ReactionEventItem[];
  reactedMessageContent?: string;
  reactedMessageAuthor?: string;
  conversationLabel?: string;
};
