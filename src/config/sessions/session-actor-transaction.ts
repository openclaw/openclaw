import type { DatabaseSync } from "node:sqlite";
import {
  withSqliteDatabaseWriteScope,
  sqliteSessionIdWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import type { SessionTranscriptAuthority } from "./session-transcript-authority.types.js";

type PublishTranscript = (authority: SessionTranscriptAuthority) => SessionTranscriptAuthority;
let current:
  | {
      database: DatabaseSync;
      state: SessionActorStoredState;
      publishTranscript?: PublishTranscript;
    }
  | undefined;

/** Lends a private working copy only for the writer's synchronous transaction. */
export function withSessionActorTransactionState<T>(
  database: { db: DatabaseSync },
  state: SessionActorStoredState,
  run: () => T,
  publishTranscript?: PublishTranscript,
): T {
  if (!database.db.isTransaction || current) {
    throw new Error("Session actor facts require one owning synchronous transaction");
  }
  current = { database: database.db, state, publishTranscript };
  try {
    const result = withSqliteDatabaseWriteScope(
      database.db,
      [
        ...state.entryRows.keys(),
        ...(state.hot.entry?.sessionId
          ? [sqliteSessionIdWriteScope(state.hot.entry.sessionId)]
          : []),
      ],
      run,
    );
    if (result instanceof Promise) {
      throw new Error("Session actor transactions cannot await work");
    }
    return result;
  } finally {
    current = undefined;
  }
}

/** Enrich the mutation owner's one final authority receipt before it is published. */
export function prepareSessionActorTranscriptAuthority(
  database: { db: DatabaseSync },
  authority: SessionTranscriptAuthority,
): SessionTranscriptAuthority {
  return current?.database === database.db && current.publishTranscript
    ? current.publishTranscript(authority)
    : authority;
}

/** Unbound native and SDK callers keep their existing database readers. */
export function readSessionActorTransactionState(
  database: { db: DatabaseSync },
  target?: { sessionKey?: string; sessionId?: string },
): SessionActorStoredState | undefined {
  const scope = current;
  if (!scope || scope.database !== database.db) {
    return undefined;
  }
  if (!database.db.isTransaction) {
    throw new Error("Session actor facts escaped their owning transaction");
  }
  if (
    (target?.sessionKey !== undefined && !scope.state.entryRows.has(target.sessionKey)) ||
    (target?.sessionId !== undefined && scope.state.hot.entry?.sessionId !== target.sessionId)
  ) {
    return undefined;
  }
  return scope.state;
}

export function cloneSessionActorStoredState(
  state: SessionActorStoredState,
): SessionActorStoredState {
  return structuredClone(state);
}
