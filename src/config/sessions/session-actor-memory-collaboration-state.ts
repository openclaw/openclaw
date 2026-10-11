import type {
  StoredSessionSuggestion,
  StoredSessionSuggestionResolution,
} from "./session-sharing-store.types.js";

export type SessionActorMemorySuggestion = {
  suggestion: StoredSessionSuggestion;
  dispatch?: { token: string; startedAt: number; resolution: StoredSessionSuggestionResolution };
};
export type SessionActorMemoryReaction = {
  sessionId: string;
  messageId: string;
  emoji: string;
  identityId: string;
  identityLabel?: string;
  createdAt: number;
};
/** Logical-session side data survives transcript-window rotation. */
export type SessionActorMemoryCollaborationState = {
  suggestions: Map<string, SessionActorMemorySuggestion>;
  reactions: SessionActorMemoryReaction[];
};
export function createSessionActorMemoryCollaborationState(): SessionActorMemoryCollaborationState {
  return { suggestions: new Map(), reactions: [] };
}
export function cloneSessionActorMemoryCollaborationState(
  state: SessionActorMemoryCollaborationState,
): SessionActorMemoryCollaborationState {
  return { suggestions: new Map(state.suggestions), reactions: [...state.reactions] };
}
