import type { SessionActorMemoryConversationOwner } from "./session-actor-memory-conversation-contract.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import type { SessionActorPhaseBackend } from "./session-actor-phase.js";

/** One synchronous operation owns these working copies until atomic installation. */
export type SessionActorMemoryStorageContext = {
  state: SessionActorMemoryState;
  readonly conversations: SessionActorMemoryConversationOwner;
  editConversations(): SessionActorMemoryConversationOwner;
  agentId: string;
  path: string;
  get(sessionKey: string): SessionActorMemoryState | undefined;
  /** Borrowed inventory for internal selection; get() authorizes a selected record before disclosure. */
  entries(): IterableIterator<[string, SessionActorMemoryState]>;
  edit(sessionKey: string): SessionActorMemoryState;
  remove(sessionKey: string): void;
  admit: SessionActorPhaseBackend["admit"];
  validateSources: SessionActorPhaseBackend["validateSources"];
};
