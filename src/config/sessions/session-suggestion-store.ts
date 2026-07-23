import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { ensureOpenClawAgentSessionSharingSchemaInTransaction } from "../../state/openclaw-agent-session-sharing-schema.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";

type SuggestionDatabase = Pick<OpenClawAgentKyselyDatabase, "session_suggestions">;

export type StoredSessionSuggestionState = "pending" | "accepted" | "dismissed";

export type StoredSessionSuggestion = {
  id: string;
  authorId: string;
  authorLabel?: string;
  text: string;
  createdAt: number;
  state: StoredSessionSuggestionState;
};

const ensuredDatabases = new WeakSet<DatabaseSync>();
export const MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR = 20;
export const MAX_PENDING_SESSION_SUGGESTIONS_PER_SESSION = 100;
export const MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS = 200;

function resolveDatabaseOptions(scope: SessionAccessScope): OpenClawAgentDatabaseOptions {
  return toDatabaseOptions(resolveSqliteScope(scope));
}

function ensureSuggestionSchema(options: OpenClawAgentDatabaseOptions): OpenClawAgentDatabase {
  const database = openOpenClawAgentDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return database;
  }
  runOpenClawAgentWriteTransaction((transactionDatabase) => {
    ensureOpenClawAgentSessionSharingSchemaInTransaction(transactionDatabase.db);
  }, options);
  ensuredDatabases.add(database.db);
  return database;
}

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
  const row =
    database.db /* sqlite-allow-raw: sync session-instance check inside the suggestion write transaction */
      .prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { current_session_id?: string; entry_json?: string } | undefined;
  let entrySessionId: string | undefined;
  try {
    const entry = row?.entry_json ? (JSON.parse(row.entry_json) as unknown) : undefined;
    const candidate =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { sessionId?: unknown }).sessionId
        : undefined;
    entrySessionId = typeof candidate === "string" ? candidate : undefined;
  } catch {
    entrySessionId = undefined;
  }
  if (
    !row ||
    entrySessionId === undefined ||
    row.current_session_id !== entrySessionId ||
    entrySessionId !== expectedSessionId
  ) {
    throw new Error("session changed before suggestion mutation");
  }
}

export function addSessionSuggestion(
  scope: SessionAccessScope,
  params: {
    authorId: string;
    authorLabel?: string;
    text: string;
    createdAt?: number;
    id?: string;
    expectedSessionId?: string;
  },
): StoredSessionSuggestion {
  const authorId = params.authorId.trim();
  const authorLabel = params.authorLabel?.trim() || undefined;
  const text = params.text.trim();
  if (!authorId || !text) {
    throw new Error("suggestion author and text are required");
  }
  const options = resolveDatabaseOptions(scope);
  ensureSuggestionSchema(options);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  const suggestion: StoredSessionSuggestion = {
    id: params.id ?? randomUUID(),
    authorId,
    ...(authorLabel ? { authorLabel } : {}),
    text,
    createdAt: params.createdAt ?? Date.now(),
    state: "pending",
  };
  runOpenClawAgentWriteTransaction((database) => {
    assertSessionInstance(database, sessionKey, params.expectedSessionId);
    const db = suggestionDb(database);
    const resolvedRows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_suggestions")
        .select("id")
        .where("session_key", "=", sessionKey)
        .where("state", "!=", "pending")
        .orderBy("created_at", "desc")
        .orderBy("id", "desc"),
    ).rows.slice(MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS);
    if (resolvedRows.length > 0) {
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("session_suggestions").where(
          "id",
          "in",
          resolvedRows.map((row) => row.id),
        ),
      );
    }
    const pendingRows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_suggestions")
        .select("author_id")
        .where("session_key", "=", sessionKey)
        .where("state", "=", "pending"),
    ).rows;
    if (pendingRows.length >= MAX_PENDING_SESSION_SUGGESTIONS_PER_SESSION) {
      throw new Error("session pending suggestion limit reached");
    }
    if (
      pendingRows.filter((row) => row.author_id === suggestion.authorId).length >=
      MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR
    ) {
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
      }),
    );
  }, options);
  return suggestion;
}

export function listSessionSuggestions(
  scope: SessionAccessScope,
  params: { authorId?: string; pendingOnly?: boolean } = {},
): StoredSessionSuggestion[] {
  const options = resolveDatabaseOptions(scope);
  const database = ensureSuggestionSchema(options);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
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

export function getSessionSuggestion(
  scope: SessionAccessScope,
  id: string,
): StoredSessionSuggestion | null {
  const options = resolveDatabaseOptions(scope);
  const database = ensureSuggestionSchema(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    suggestionDb(database)
      .selectFrom("session_suggestions")
      .select(["id", "author_id", "author_label", "text", "created_at", "state"])
      .where("session_key", "=", resolveSqliteScope(scope).sessionKey)
      .where("id", "=", id),
  );
  return row ? toSuggestion(row) : null;
}

export function resolveSessionSuggestion(
  scope: SessionAccessScope,
  params: {
    id: string;
    state: Exclude<StoredSessionSuggestionState, "pending">;
    expectedSessionId?: string;
  },
): StoredSessionSuggestion | null {
  const options = resolveDatabaseOptions(scope);
  ensureSuggestionSchema(options);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  return runOpenClawAgentWriteTransaction((database) => {
    assertSessionInstance(database, sessionKey, params.expectedSessionId);
    const db = suggestionDb(database);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_suggestions")
        .select(["id", "author_id", "author_label", "text", "created_at", "state"])
        .where("session_key", "=", sessionKey)
        .where("id", "=", params.id)
        .where("state", "=", "pending"),
    );
    if (!row) {
      return null;
    }
    const updated = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_suggestions")
        .set({ state: params.state })
        .where("session_key", "=", sessionKey)
        .where("id", "=", params.id)
        .where("state", "=", "pending"),
    );
    return (updated.numAffectedRows ?? 0n) > 0n
      ? { ...toSuggestion(row), state: params.state }
      : null;
  }, options);
}
