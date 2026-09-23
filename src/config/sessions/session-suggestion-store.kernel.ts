import { randomUUID } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { SessionWorkStartInvalidatedError } from "./lifecycle.js";
import { readSessionEntryInstanceId } from "./session-accessor.sqlite-entry-identity.js";

type SuggestionDatabase = Pick<OpenClawAgentKyselyDatabase, "session_suggestions">;

type StoredSessionSuggestionState = "pending" | "accepted" | "dismissed";
type StoredSessionSuggestionResolution = "send" | "queue" | "edit" | "dismiss";

export type StoredSessionSuggestion = {
  id: string;
  authorId: string;
  authorLabel?: string;
  text: string;
  createdAt: number;
  state: StoredSessionSuggestionState;
};

const MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR = 20;
const MAX_PENDING_SESSION_SUGGESTIONS_PER_SESSION = 100;
const MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS = 200;
export const SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS = 30_000;

function suggestionDb(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<SuggestionDatabase>(database.db);
}

function toSuggestion(row: {
  id: string;
  author_id: string;
  author_label: string | null;
  text: string;
  created_at: number;
  state: string;
}): StoredSessionSuggestion {
  return {
    id: row.id,
    authorId: row.author_id,
    ...(row.author_label ? { authorLabel: row.author_label } : {}),
    text: row.text,
    createdAt: row.created_at,
    // SAFETY: session_suggestions.state has the matching schema CHECK constraint.
    state: row.state as StoredSessionSuggestionState,
  };
}

function assertSessionInstance(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  expectedSessionId: string | undefined,
): void {
  if (expectedSessionId === undefined) {
    return;
  }
  if (readSessionEntryInstanceId(database, sessionKey) !== expectedSessionId) {
    throw new SessionWorkStartInvalidatedError("session changed before suggestion mutation");
  }
}

function pruneResolvedSessionSuggestions(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  const db = suggestionDb(database);
  const resolvedRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_suggestions")
      .select("id")
      .where("session_key", "=", sessionKey)
      .where("state", "!=", "pending")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      // SQLite requires LIMIT for OFFSET; -1 preserves the unbounded deletion tail.
      .limit((eb) => eb.lit(-1))
      .offset((eb) => eb.lit(MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS)),
  ).rows;
  if (resolvedRows.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_suggestions").where(
      "id",
      "in",
      resolvedRows.map((row) => row.id),
    ),
  );
}

export function addSessionSuggestionInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: {
    suggestion: StoredSessionSuggestion & { state: "pending" };
    expectedSessionId?: string;
  },
): StoredSessionSuggestion {
  const suggestion = params.suggestion;
  assertSessionInstance(database, sessionKey, params.expectedSessionId);
  const db = suggestionDb(database);
  pruneResolvedSessionSuggestions(database, sessionKey);
  // Compare decoded IDs in JS; binding the author here changes malformed-ID
  // matching and can move binding errors ahead of the session-cap error.
  const pendingCounts = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_suggestions")
      .select((eb) => ["author_id", eb.fn.countAll<number>().as("count")])
      .where("session_key", "=", sessionKey)
      .where("state", "=", "pending")
      .groupBy("author_id"),
  ).rows.reduce(
    (counts, row) => ({
      session: counts.session + row.count,
      author: counts.author + (row.author_id === suggestion.authorId ? row.count : 0),
    }),
    { session: 0, author: 0 },
  );
  if (pendingCounts.session >= MAX_PENDING_SESSION_SUGGESTIONS_PER_SESSION) {
    throw new Error("session pending suggestion limit reached");
  }
  if (pendingCounts.author >= MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR) {
    throw new Error("author pending suggestion limit reached");
  }
  executeSqliteQuerySync(
    database.db,
    db.insertInto("session_suggestions").values({
      id: suggestion.id,
      session_key: sessionKey,
      author_id: suggestion.authorId,
      author_label: suggestion.authorLabel ?? null,
      text: suggestion.text,
      created_at: suggestion.createdAt,
      state: suggestion.state,
      dispatch_token: null,
      dispatch_started_at: null,
      dispatch_resolution: null,
    }),
  );
  return suggestion;
}

export function listSessionSuggestionsInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: { authorId?: string; pendingOnly?: boolean } = {},
): StoredSessionSuggestion[] {
  let query = suggestionDb(database)
    .selectFrom("session_suggestions")
    .select(["id", "author_id", "author_label", "text", "created_at", "state"])
    .where("session_key", "=", sessionKey);
  if (params.authorId?.trim()) {
    query = query.where("author_id", "=", params.authorId.trim());
  }
  if (params.pendingOnly) {
    query = query.where("state", "=", "pending");
  }
  return executeSqliteQuerySync(
    database.db,
    query.orderBy("created_at", "asc").orderBy("id", "asc"),
  ).rows.map(toSuggestion);
}

type SessionSuggestionDispatchClaim =
  | { kind: "busy" }
  | { kind: "mismatch"; resolution: StoredSessionSuggestionResolution }
  | { kind: "claimed"; suggestion: StoredSessionSuggestion; token: string };

export function claimSessionSuggestionDispatchInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: {
    id: string;
    expectedSessionId?: string;
    resolution: StoredSessionSuggestionResolution;
    now?: number;
    claimTtlMs?: number;
  },
): SessionSuggestionDispatchClaim | null {
  assertSessionInstance(database, sessionKey, params.expectedSessionId);
  const db = suggestionDb(database);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_suggestions")
      .select([
        "id",
        "author_id",
        "author_label",
        "text",
        "created_at",
        "state",
        "dispatch_token",
        "dispatch_started_at",
        "dispatch_resolution",
      ])
      .where("session_key", "=", sessionKey)
      .where("id", "=", params.id)
      .where("state", "=", "pending"),
  );
  if (!row) {
    return null;
  }
  const now = params.now ?? Date.now();
  const claimTtlMs = params.claimTtlMs ?? SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS;
  if (
    row.dispatch_token &&
    row.dispatch_started_at !== null &&
    now - row.dispatch_started_at < claimTtlMs
  ) {
    return { kind: "busy" };
  }
  if (row.dispatch_resolution && row.dispatch_resolution !== params.resolution) {
    return {
      kind: "mismatch",
      // SAFETY: the non-null dispatch_resolution value has the matching schema CHECK constraint.
      resolution: row.dispatch_resolution as StoredSessionSuggestionResolution,
    };
  }
  const token = randomUUID();
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_suggestions")
      .set({
        dispatch_token: token,
        dispatch_started_at: now,
        dispatch_resolution: params.resolution,
      })
      .where("session_key", "=", sessionKey)
      .where("id", "=", params.id)
      .where("state", "=", "pending"),
  );
  return { kind: "claimed", suggestion: toSuggestion(row), token };
}

export function releaseSessionSuggestionDispatchInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: { id: string; token: string; expectedSessionId?: string },
): boolean {
  assertSessionInstance(database, sessionKey, params.expectedSessionId);
  const result = executeSqliteQuerySync(
    database.db,
    suggestionDb(database)
      .updateTable("session_suggestions")
      .set({ dispatch_token: null, dispatch_started_at: null, dispatch_resolution: null })
      .where("session_key", "=", sessionKey)
      .where("id", "=", params.id)
      .where("state", "=", "pending")
      .where("dispatch_token", "=", params.token),
  );
  return (result.numAffectedRows ?? 0n) > 0n;
}

export function finalizeSessionSuggestionClaimInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: {
    id: string;
    token: string;
    state: Exclude<StoredSessionSuggestionState, "pending">;
    expectedSessionId?: string;
  },
): StoredSessionSuggestion | null {
  assertSessionInstance(database, sessionKey, params.expectedSessionId);
  const db = suggestionDb(database);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_suggestions")
      .select(["id", "author_id", "author_label", "text", "created_at", "state"])
      .where("session_key", "=", sessionKey)
      .where("id", "=", params.id)
      .where("state", "=", "pending")
      .where("dispatch_token", "=", params.token),
  );
  if (!row) {
    return null;
  }
  const updated = executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_suggestions")
      .set({
        state: params.state,
        dispatch_token: null,
        dispatch_started_at: null,
        dispatch_resolution: null,
      })
      .where("session_key", "=", sessionKey)
      .where("id", "=", params.id)
      .where("state", "=", "pending")
      .where("dispatch_token", "=", params.token),
  );
  if ((updated.numAffectedRows ?? 0n) === 0n) {
    return null;
  }
  pruneResolvedSessionSuggestions(database, sessionKey);
  return { ...toSuggestion(row), state: params.state };
}
