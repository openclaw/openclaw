export type RealtimeTalkConversationRole = "user" | "assistant";

export type RealtimeTalkConversationEntry = {
  id: string;
  role: RealtimeTalkConversationRole;
  text: string;
  isStreaming: boolean;
  order?: number;
  transcriptId?: string;
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
