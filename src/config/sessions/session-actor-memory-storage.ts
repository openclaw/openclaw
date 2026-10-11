import { isDeepStrictEqual } from "node:util";
import { BoardValidationError } from "../../boards/board-layout.js";
import { parseAgentSessionKey, toAgentStoreSessionKey } from "../../routing/session-key.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { SessionGoalOperationError } from "./goals-operations.types.js";
import type {
  SessionActor,
  SessionActorLifetime,
  SessionActorTarget,
} from "./session-actor-contract.js";
import type { SessionActorExecutorGuards } from "./session-actor-executor.js";
import {
  cloneSessionActorMemoryConversations,
  type SessionActorMemoryConversationOwner,
} from "./session-actor-memory-conversation-contract.js";
import {
  selectSessionActorMemoryConversations,
  syncSessionActorMemoryConversations,
} from "./session-actor-memory-conversation.js";
import { publishSessionActorMemoryChanges } from "./session-actor-memory-publication.js";
import { validateSessionActorMemorySources } from "./session-actor-memory-sources.js";
import {
  advanceSessionActorMemoryState,
  cloneSessionActorMemoryState,
  createSessionActorMemoryState,
  type SessionActorMemoryRecord,
  type SessionActorMemoryState,
} from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import {
  mutateSessionActorMemoryStorage,
  readSessionActorMemoryStorage,
} from "./session-actor-memory-storage-dispatch.js";
import type {
  SessionActorStorage,
  SessionActorStorageAuthority,
  SessionActorStorageChange,
  SessionActorStorageCommand,
  SessionActorStorageOutcome,
  SessionActorStorageQuery,
  SessionActorStorageReads,
  SessionActorStorageWrites,
} from "./session-actor-storage-contract.js";
import {
  SqliteTranscriptMutationConflictError,
  SqliteSessionMutationConflictError,
  SessionEntryLifecycleUpsertConflictError,
} from "./session-mutation-conflict-error.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import {
  SessionTranscriptWriterClaimReboundError,
  parseTranscriptAppendRefusal,
} from "./session-transcript-writer-claim-error.js";

function errorFacts(error: unknown) {
  if (error instanceof SqliteTranscriptMutationConflictError) {
    return { name: error.name, message: error.message, sessionId: error.sessionId };
  }
  if (error instanceof SqliteSessionMutationConflictError) {
    return { name: error.name, message: error.message, operationLabel: error.operationLabel };
  }
  if (error instanceof SessionEntryLifecycleUpsertConflictError) {
    return { name: error.name, message: error.message, sessionKey: error.sessionKey };
  }
  if (error instanceof SessionPendingInputCustodyError) {
    return { name: "SessionPendingInputCustodyError", message: error.message };
  }
  if (error instanceof SessionTranscriptWriterClaimReboundError) {
    return {
      name: error.name,
      message: error.message,
      refusal: parseTranscriptAppendRefusal(error.cause),
    };
  }
  if (error instanceof BoardValidationError || error instanceof SessionGoalOperationError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: "Session actor storage command failed" };
}

/** Storage and phase commands share this owner's FIFO; every operation below is synchronous. */
export function createSessionActorMemoryStorage(options: {
  agentId: string;
  path: string;
  target: SessionActorTarget;
  sessions: Map<string, SessionActorMemoryRecord>;
  current(): SessionActorMemoryState;
  enqueue<T>(run: () => T): Promise<T>;
  guards: SessionActorExecutorGuards;
  acquire(sessionKey: string, lifetime?: SessionActorLifetime): Promise<SessionActor>;
  prepareInstall(state: SessionActorMemoryState): void;
  conversations(): SessionActorMemoryConversationOwner;
  installConversations(value: SessionActorMemoryConversationOwner): void;
}): SessionActorStorage {
  const { sessions, target } = options;
  const transaction = (authority: SessionActorStorageAuthority, writable: boolean) => {
    const before = options.current();
    let conversations: SessionActorMemoryConversationOwner | undefined;
    const changed = new Map<string, SessionActorMemoryState | undefined>();
    const authorized = new Set<string>();
    const authorize = (sessionKey: string, state: SessionActorMemoryState | undefined) => {
      if (state && !authorized.has(sessionKey)) {
        // Synchronous work uses one effect-policy check against the authoritative preimage.
        authority.authorize("commit", structuredClone(state.hot));
        authorized.add(sessionKey);
      }
    };
    const get = (sessionKey: string) => {
      const state = changed.has(sessionKey)
        ? changed.get(sessionKey)
        : sessions.get(sessionKey)?.state;
      authorize(sessionKey, state);
      return state;
    };
    const assertWritableKey = (sessionKey: string) => {
      if (!writable) {
        throw new Error("Session actor read cannot mutate storage");
      }
      if (
        !isIncognitoSessionKey(sessionKey) ||
        parseAgentSessionKey(sessionKey)?.agentId !== options.agentId ||
        toAgentStoreSessionKey({ agentId: options.agentId, requestKey: sessionKey }) !== sessionKey
      ) {
        throw new Error(
          "Memory session storage requires a canonical incognito key owned by this agent",
        );
      }
    };
    const edit = (sessionKey: string) => {
      assertWritableKey(sessionKey);
      if (changed.has(sessionKey) && changed.get(sessionKey)) {
        return changed.get(sessionKey)!;
      }
      const existing = get(sessionKey);
      const state = existing
        ? cloneSessionActorMemoryState(existing)
        : createSessionActorMemoryState({ ...target, sessionKey });
      authorize(sessionKey, state);
      changed.set(sessionKey, state);
      return state;
    };
    authorize(target.sessionKey, before);
    const state = writable ? edit(target.sessionKey) : before;
    const context: SessionActorMemoryStorageContext = {
      ...options,
      state,
      get conversations() {
        return conversations ?? options.conversations();
      },
      editConversations() {
        if (!writable) {
          throw new Error("Session actor read cannot mutate conversations");
        }
        return (conversations ??= cloneSessionActorMemoryConversations(options.conversations()));
      },
      get,
      *entries() {
        const keys = new Set([...sessions.keys(), ...changed.keys()]);
        for (const key of keys) {
          const value = changed.has(key) ? changed.get(key) : sessions.get(key)?.state;
          if (value) {
            yield [key, value];
          }
        }
      },
      edit,
      remove(sessionKey) {
        assertWritableKey(sessionKey);
        get(sessionKey);
        changed.set(sessionKey, undefined);
      },
      admit(stage, publication) {
        authority.authorize(stage, structuredClone(state.hot), publication);
      },
      validateSources(sources) {
        if (target.database.kind !== "memory") {
          throw new Error("Memory storage has no memory identity");
        }
        return validateSessionActorMemorySources(
          get,
          target.database.incarnation,
          sources,
          (query) => selectSessionActorMemoryConversations(context, query),
        );
      },
    };
    return {
      context,
      changed,
      installConversations() {
        if (conversations) {
          options.installConversations(conversations);
        }
      },
    };
  };
  const readCurrent: SessionActorStorage["readCurrent"] = (query, authority) => {
    options.guards.assertReadable();
    const { context } = transaction(authority, false);
    // SAFETY: The public generic correlates this query's key, input, and output.
    const value = readSessionActorMemoryStorage(
      context,
      query as SessionActorStorageQuery,
    ) as SessionActorStorageReads[typeof query.type]["output"];
    authority.assertCurrent();
    return structuredClone(value);
  };
  return {
    acquire: options.acquire,
    readCurrent,
    read(query, authority) {
      return options.enqueue(() => readCurrent(query, authority));
    },
    mutate(command, authority, observer) {
      return options.enqueue(() => {
        type Value = SessionActorStorageWrites[typeof command.type]["output"];
        try {
          options.guards.assertAccepted();
          const { context, changed, installConversations } = transaction(authority, true);
          // SAFETY: The public generic correlates this command's key, input, and output.
          const value = mutateSessionActorMemoryStorage(
            context,
            command as SessionActorStorageCommand,
            authority,
          ) as Value;
          const changes: SessionActorStorageChange[] = [];
          for (const [sessionKey, state] of changed) {
            const previous = sessions.get(sessionKey)?.state;
            if (state) {
              if (!isDeepStrictEqual(previous?.hot.entry, state.hot.entry)) {
                syncSessionActorMemoryConversations(
                  state,
                  context.editConversations(),
                  previous?.hot.entry,
                );
              }
              options.prepareInstall(state);
              advanceSessionActorMemoryState(state);
            }
            changes.push({ sessionKey, before: previous?.hot, after: state?.hot });
          }
          // No await follows admission; a callback's reentrant close may race this accepted install.
          authority.assertCurrent();
          // Detach before installation: an uncloneable result cannot leave a partial commit.
          const committed = structuredClone({ kind: "committed" as const, value, changes });
          for (const [sessionKey, state] of changed) {
            const previous = sessions.get(sessionKey);
            if (!state) {
              if (previous) {
                previous.closed = true;
              }
              sessions.delete(sessionKey);
            } else if (
              previous &&
              previous.state.hot.entry &&
              previous.state.hot.entry.sessionId !== state.hot.entry?.sessionId
            ) {
              // Existing handles stay closed after rotation; new acquisition adopts this state.
              previous.closed = true;
              sessions.set(sessionKey, { state, closed: false });
            } else if (previous) {
              previous.state = state;
            } else {
              sessions.set(sessionKey, { state, closed: false });
            }
          }
          installConversations();
          const outcome: SessionActorStorageOutcome<Value> = committed;
          try {
            if (target.database.kind !== "memory") {
              throw new Error("Memory storage lost its owner");
            }
            publishSessionActorMemoryChanges(
              { ...options, incarnation: target.database.incarnation },
              committed.changes,
            );
            observer?.committed(structuredClone(committed));
          } catch (error) {
            outcome.failure = errorFacts(error);
          }
          return outcome;
        } catch (error) {
          return { kind: "rolled-back", error: errorFacts(error) };
        }
      });
    },
  };
}
