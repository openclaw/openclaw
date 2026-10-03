// Leaf contract shared by the reaction kernel and the history-worker read
// results; it must stay import-free so session-history-types.ts never reaches
// the kernel (whose lifecycle import would close a session-accessor cycle).
export type StoredMessageReactionSummary = {
  emoji: string;
  count: number;
  identities: Array<{ id: string; label?: string }>;
};

export type SetSessionReactionParams = {
  messageId: string;
  emoji: string;
  identityId: string;
  identityLabel?: string;
  remove?: boolean;
  expectedSessionId: string;
};

/** `changed` is false for an add that already exists or a remove with nothing to remove. */
export type SessionReactionWrite = {
  reactions: StoredMessageReactionSummary[];
  /** Newest surviving row by created_at, independent of first-created summary order. */
  newestRemainingEmoji: string | undefined;
  changed: boolean;
};
