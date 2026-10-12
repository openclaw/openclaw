import type { SessionMember, SessionParticipantRecord } from "./session-membership-facts.types.js";
import type {
  SessionReactionWrite,
  SetSessionReactionParams,
  StoredMessageReactionSummary,
} from "./session-reaction-store.types.js";
import type {
  SessionSharingWorkerOperations,
  SessionSuggestionListParams,
  StoredSessionSuggestion,
} from "./session-sharing-store.types.js";
import type { InternalSessionEntry } from "./types.js";

export type SessionActorMemoryCollaborationReads = {
  "session.members.read": {
    input: Record<string, never>;
    output: { entry: InternalSessionEntry | undefined; members: SessionMember[] };
  };
  "session.participants.read": { input: Record<string, never>; output: SessionParticipantRecord[] };
  "session.suggestions.read": {
    input: { params?: SessionSuggestionListParams };
    output: StoredSessionSuggestion[];
  };
  "session.reactions.read": {
    input: { sessionId: string };
    output: Record<string, StoredMessageReactionSummary[]>;
  };
};

type SharingWrites = {
  [
    Key in Exclude<
      keyof SessionSharingWorkerOperations,
      "category.prepare" | "category.apply"
    > as `session.collaboration.${Key}`
  ]: {
    input: Omit<SessionSharingWorkerOperations[Key]["input"], "scope"> &
      (Key extends "participant" ? { profileAliases?: string[] } : unknown);
    output: SessionSharingWorkerOperations[Key]["output"];
  };
};

export type SessionActorMemoryCollaborationWrites = SharingWrites & {
  "session.category.apply": {
    input: { from: string; to?: string };
    output: SessionSharingWorkerOperations["category.apply"]["output"];
  };
  "session.reaction.set": {
    input: { params: SetSessionReactionParams };
    output: SessionReactionWrite;
  };
};

export type SessionActorMemoryCollaborationCommand = {
  [Key in keyof SessionActorMemoryCollaborationWrites]: {
    type: Key;
    input: SessionActorMemoryCollaborationWrites[Key]["input"];
  };
}[keyof SessionActorMemoryCollaborationWrites];
