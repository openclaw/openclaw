import { parseAgentSessionKey, toAgentStoreSessionKey } from "../../routing/session-key.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { SessionGoalOperationError } from "./goals-operations.types.js";
import type { SessionActorTarget } from "./session-actor-contract.js";
import type { SessionActorExecutorGuards } from "./session-actor-executor.js";
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

function errorFacts(error: unknown) {
  if (error instanceof SessionGoalOperationError) {
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
}): SessionActorStorage {
  const { sessions, target } = options;
  const transaction = (authority: SessionActorStorageAuthority, writable: boolean) => {
    const before = options.current();
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
        return validateSessionActorMemorySources(get, target.database.incarnation, sources);
      },
    };
    return { context, changed };
  };
  return {
    read(query, authority) {
      return options.enqueue(() => {
        options.guards.assertReadable();
        const { context } = transaction(authority, false);
        // SAFETY: read() receives the matching input for its query discriminator.
        const selected = query as SessionActorStorageQuery;
        const result = readSessionActorMemoryStorage(context, selected);
        // SAFETY: The dispatcher returns this discriminator's declared output.
        const value = result as SessionActorStorageReads[typeof query.type]["output"];
        authority.assertCurrent();
        return structuredClone(value);
      });
    },
    mutate(command, authority, observer) {
      return options.enqueue(() => {
        type Value = SessionActorStorageWrites[typeof command.type]["output"];
        try {
          options.guards.assertAccepted();
          const { context, changed } = transaction(authority, true);
          // SAFETY: mutate() receives the matching input for its command discriminator.
          const selected = command as SessionActorStorageCommand;
          const result = mutateSessionActorMemoryStorage(context, selected, authority);
          // SAFETY: The dispatcher returns this discriminator's declared output.
          const value = result as Value;
          const changes: SessionActorStorageChange[] = [];
          for (const [sessionKey, state] of changed) {
            const previous = sessions.get(sessionKey)?.state;
            if (state) {
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
          const outcome: SessionActorStorageOutcome<Value> = committed;
          try {
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
