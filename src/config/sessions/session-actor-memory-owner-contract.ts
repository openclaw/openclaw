import type { ConversationIdentity } from "./conversation-identity.js";
import type { ConversationReadQuery, ConversationRecord } from "./conversation-registry.types.js";
import type { SessionActor, SessionActorFactory } from "./session-actor-contract.js";
import type {
  SessionActorMemoryConversationReads,
  SessionActorMemoryConversationWrites,
} from "./session-actor-memory-conversation-contract.js";
import type {
  SessionActorAuthority,
  SessionActorHotState,
  SessionActorLifetime,
  SessionActorTarget,
} from "./session-actor-state.types.js";
import type {
  SessionActorStorageAuthority,
  SessionActorStorageReads,
} from "./session-actor-storage-contract.js";
import type { SessionEntryProjection } from "./session-entry-snapshot-values.js";
import type { InternalSessionEntry } from "./types.js";

export type MemoryOwnerOptions = { agentId: string; path: string };

/** Registry readers avoid the factory; lexical callbacks stay safe to pass unbound. */
export type MemorySessionActorOwner = MemoryOwnerOptions &
  SessionActorFactory & {
    identity: Readonly<Extract<SessionActorTarget["database"], { kind: "memory" }>>;
    assertCurrent: () => void;
    readSession: (
      sessionKey: string,
      authority: SessionActorAuthority,
    ) => SessionActorHotState | undefined;
    captureSessionReadGuard(sessionKey: string): () => void;
    readStorage<Key extends keyof SessionActorStorageReads>(
      sessionKey: string,
      query: { type: Key; input: SessionActorStorageReads[Key]["input"] },
      authority: SessionActorStorageAuthority,
    ): SessionActorStorageReads[Key]["output"] | undefined;
    readConversations(
      query: ConversationReadQuery,
      authority: SessionActorAuthority,
    ): ConversationRecord[];
    readSessionById(
      sessionId: string,
      authority: SessionActorAuthority,
      selection?: { currentOnly?: boolean; orderBy?: "updatedAt" },
    ): { sessionKey: string; entry: InternalSessionEntry } | undefined;
    listSessions(authority: SessionActorAuthority): SessionActorHotState[];
    listSessionEntries(
      authority: SessionActorAuthority,
      projection?: SessionEntryProjection,
    ): { sessionKey: string; entry: InternalSessionEntry }[];
    acquireExisting(
      sessionKey: string,
      lifetime: SessionActorLifetime,
    ): Promise<SessionActor | undefined>;
    closeSession(sessionKey: string): void;
    close(): void;
    readConversation: <Key extends keyof SessionActorMemoryConversationReads>(
      query: { type: Key; input: SessionActorMemoryConversationReads[Key]["input"] },
      authority: SessionActorAuthority,
    ) => SessionActorMemoryConversationReads[Key]["output"];
    readConversationAfterWrites<Key extends keyof SessionActorMemoryConversationReads>(
      query: { type: Key; input: SessionActorMemoryConversationReads[Key]["input"] },
      authority: SessionActorAuthority,
    ): Promise<SessionActorMemoryConversationReads[Key]["output"]>;
    mutateConversation<Key extends keyof SessionActorMemoryConversationWrites>(
      command: { type: Key; input: SessionActorMemoryConversationWrites[Key]["input"] },
      authority: SessionActorAuthority,
      selectEligible?: (identities: readonly ConversationIdentity[]) => readonly boolean[],
    ): Promise<SessionActorMemoryConversationWrites[Key]["output"]>;
  };
