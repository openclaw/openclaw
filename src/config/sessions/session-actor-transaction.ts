import type { DatabaseSync } from "node:sqlite";
import {
  withSqliteDatabaseWriteScope,
  sqliteSessionIdWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import type { SessionEntryWritePostimage } from "./session-entry-write-postimage.js";
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

const sharedCollections = new WeakSet<object>();

/** Rows and payloads are replaced, never edited; detach their collection on its first write. */
export function writableSessionActorMap<K, V>(rows: Map<K, V>): Map<K, V> {
  return sharedCollections.has(rows) ? new Map(rows) : rows;
}

export function writableSessionActorNavigation(
  navigation: SessionActorStoredState["transcript"]["navigation"],
): SessionActorStoredState["transcript"]["navigation"] {
  return sharedCollections.has(navigation) ? [...navigation] : navigation;
}

export function replaceSessionActorStoredEntry(
  state: SessionActorStoredState,
  sessionKey: string,
  postimage: Pick<SessionEntryWritePostimage, "entry" | "row" | "window">,
): void {
  state.entryRows = writableSessionActorMap(state.entryRows);
  state.entryRows.set(sessionKey, {
    entry: structuredClone(postimage.entry),
    row: postimage.row,
  });
  state.hot.entry = structuredClone(postimage.entry);
  state.window = postimage.window;
}

/** Fork only mutable containers; discarded working state cannot change the resident preimage. */
export function forkSessionActorStoredState(
  state: SessionActorStoredState,
): SessionActorStoredState {
  for (const collection of [
    state.entryRows,
    state.pendingInputs,
    state.completions,
    state.transcript.identities,
    state.transcript.active,
    state.transcript.payloads,
    state.transcript.navigation,
  ]) {
    sharedCollections.add(collection);
  }
  return {
    ...state,
    hot: {
      ...state.hot,
      transcript: {
        ...state.hot.transcript,
        version: { ...state.hot.transcript.version },
        watermark: { ...state.hot.transcript.watermark },
      },
    },
    window: state.window && { ...state.window },
    transcript: { ...state.transcript },
  };
}
