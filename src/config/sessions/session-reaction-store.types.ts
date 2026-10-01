// Leaf contract shared by the reaction kernel and the history-worker read
// results; it must stay import-free so session-history-types.ts never reaches
// the kernel (whose lifecycle import would close a session-accessor cycle).
export type StoredMessageReactionSummary = {
  emoji: string;
  count: number;
  identities: Array<{ id: string; label?: string }>;
};
