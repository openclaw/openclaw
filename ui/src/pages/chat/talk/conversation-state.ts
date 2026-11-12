export type RealtimeTalkConversationRole = "user" | "assistant";

export type RealtimeTalkConversationEntry = {
  id: string;
  role: RealtimeTalkConversationRole;
  text: string;
  isStreaming: boolean;
  order?: number;
  transcriptId?: string;
  /**
   * Newest saved chat message when the caption started, or null when the chat was
   * empty. Places unsaved captions among typed messages; undefined renders last.
   */
  afterMessageId?: string | null;
};

export type RealtimeTalkConversationState = {
  entries: RealtimeTalkConversationEntry[];
  nextEntryId: number;
  userEntryId: string | null;
  userEntryAwaitingFinalStartedAtMs: number | null;
  assistantEntryId: string | null;
};

export function createRealtimeTalkConversationState(): RealtimeTalkConversationState {
  return {
    entries: [],
    nextEntryId: 1,
    userEntryId: null,
    userEntryAwaitingFinalStartedAtMs: null,
    assistantEntryId: null,
  };
}

export function continueRealtimeTalkConversation(
  state: RealtimeTalkConversationState,
): RealtimeTalkConversationState {
  return {
    ...createRealtimeTalkConversationState(),
    nextEntryId: state.nextEntryId,
    entries: state.entries.map((entry, order) => ({ ...entry, order, isStreaming: false })),
  };
}

/**
 * Ending a call keeps only finished captions whose saved message is still in
 * flight, so speech does not vanish until history shows it. A failed save leaves
 * its caption until the next call or session change resets the conversation.
 */
export function retainSavingRealtimeTalkCaptions(
  state: RealtimeTalkConversationState,
): RealtimeTalkConversationState {
  return {
    ...createRealtimeTalkConversationState(),
    nextEntryId: state.nextEntryId,
    entries: state.entries.filter((entry) => entry.transcriptId && !entry.isStreaming),
  };
}
