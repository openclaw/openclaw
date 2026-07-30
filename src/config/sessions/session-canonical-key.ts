import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

const SESSION_CANONICAL_KEY_REPAIR_COMMAND = "openclaw doctor --fix";
type CanonicalSessionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_key_contract" | "session_key_revisions" | "session_nodes" | "session_windows"
>;
type CanonicalSessionKeyToken = { revision: number };
const validatedDatabases = new WeakMap<
  DatabaseSync,
  { mainKey: string; token: CanonicalSessionKeyToken }
>();

class SessionCanonicalKeyMigrationRequiredError extends Error {
  readonly code = "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED";

  constructor(
    sessionKey: string,
    reason: "duplicate" | "non-canonical-row" | "non-canonical-write",
  ) {
    const detail =
      reason === "duplicate"
        ? `duplicate rows resolve to canonical session key ${sessionKey}`
        : reason === "non-canonical-row"
          ? `non-canonical persisted row resolves to session key ${sessionKey}`
          : `refusing non-canonical session key write ${sessionKey}`;
    super(`${detail}; stop the Gateway and run ${SESSION_CANONICAL_KEY_REPAIR_COMMAND}`);
    this.name = "SessionCanonicalKeyMigrationRequiredError";
  }
}

function isCanonicalSessionKey(sessionKey: string): boolean {
  const trimmed = sessionKey.trim();
  if (!trimmed || sessionKey !== trimmed) {
    return false;
  }
  if (normalizeStoreSessionKey(sessionKey) !== sessionKey) {
    return false;
  }
  const parsed = parseAgentSessionKey(trimmed);
  return (
    trimmed === "global" ||
    trimmed === "unknown" ||
    (parsed !== null && trimmed.startsWith(`agent:${parsed.agentId}:`))
  );
}

export function assertCanonicalSessionKeyWrite(sessionKey: string, expectedAgentId?: string): void {
  const parsed = parseAgentSessionKey(sessionKey);
  if (
    !isCanonicalSessionKey(sessionKey) ||
    (expectedAgentId && parsed && parsed.agentId !== normalizeAgentId(expectedAgentId))
  ) {
    throw new SessionCanonicalKeyMigrationRequiredError(sessionKey, "non-canonical-write");
  }
}

function readCanonicalSessionMainKey(database: { db: DatabaseSync }): string {
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  return normalizeMainKey(
    executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
    )?.main_key,
  );
}

function assertCanonicalSessionMainKeyWrite(sessionKey: string, mainKey: string): void {
  if (parseAgentSessionKey(sessionKey)?.rest === "main" && mainKey !== "main") {
    throw nonCanonicalSessionKeyWriteError(sessionKey);
  }
}

export function assertCanonicalSessionEntryLineageWrite(
  database: { db: DatabaseSync },
  entry: SessionEntry,
): void {
  const sessionKeys = [entry.parentSessionKey, entry.spawnedBy].filter(
    (sessionKey): sessionKey is string => sessionKey !== undefined,
  );
  if (sessionKeys.length === 0) {
    return;
  }
  const mainKey = readCanonicalSessionMainKey(database);
  for (const sessionKey of sessionKeys) {
    assertCanonicalSessionKeyWrite(sessionKey);
    assertCanonicalSessionMainKeyWrite(sessionKey, mainKey);
  }
}

export function assertCanonicalSessionKeyWriteMatchesDatabase(
  database: { agentId: string; db: DatabaseSync },
  sessionKey: string,
): void {
  assertCanonicalSessionKeyWrite(sessionKey, database.agentId);
  assertCanonicalSessionMainKeyWrite(sessionKey, readCanonicalSessionMainKey(database));
}

export function duplicateCanonicalSessionKeyError(
  canonicalKey: string,
): SessionCanonicalKeyMigrationRequiredError {
  return new SessionCanonicalKeyMigrationRequiredError(canonicalKey, "duplicate");
}

export function nonCanonicalSessionKeyRowError(
  canonicalKey: string,
): SessionCanonicalKeyMigrationRequiredError {
  return new SessionCanonicalKeyMigrationRequiredError(canonicalKey, "non-canonical-row");
}

function nonCanonicalSessionKeyWriteError(
  sessionKey: string,
): SessionCanonicalKeyMigrationRequiredError {
  return new SessionCanonicalKeyMigrationRequiredError(sessionKey, "non-canonical-write");
}

function readCanonicalSessionKeyToken(database: DatabaseSync): CanonicalSessionKeyToken {
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("session_key_revisions").select("revision").where("id", "=", 1),
  );
  if (typeof row?.revision !== "number") {
    throw new Error("SQLite did not return the canonical session-key revision");
  }
  return { revision: row.revision };
}

function canonicalSessionKeyTokensEqual(
  left: CanonicalSessionKeyToken,
  right: CanonicalSessionKeyToken,
): boolean {
  return left.revision === right.revision;
}

export function assertCanonicalSqliteSessionKeysCurrent(
  database: { agentId: string; db: DatabaseSync },
  mainKey?: string,
): CanonicalSessionKeyToken {
  const token = readCanonicalSessionKeyToken(database.db);
  const cached = validatedDatabases.get(database.db);
  if (
    cached &&
    (mainKey === undefined || cached.mainKey === normalizeMainKey(mainKey)) &&
    canonicalSessionKeyTokensEqual(cached.token, token)
  ) {
    return token;
  }
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const storedMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  const canonicalMainKey = normalizeMainKey(mainKey ?? storedMainKey);
  for (const row of executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .leftJoin("session_windows as retained_window", (join) =>
        join
          .onRef("retained_window.session_id", "=", "session_nodes.current_session_id")
          .onRef("retained_window.session_key", "=", "session_nodes.session_key"),
      )
      .select([
        "session_nodes.session_key",
        "session_nodes.current_session_id",
        "session_nodes.entry_json",
        "session_nodes.parent_session_key",
        "session_nodes.spawned_by",
        "retained_window.session_id as retained_window_id",
      ]),
  ).rows) {
    if (row.entry_json === "{}" && row.retained_window_id === row.current_session_id) {
      continue;
    }
    const trimmed = row.session_key.trim();
    const parsed = parseAgentSessionKey(trimmed);
    if (
      row.session_key !== trimmed ||
      normalizeStoreSessionKey(trimmed) !== trimmed ||
      (!parsed && trimmed !== "global" && trimmed !== "unknown") ||
      (parsed && parsed.agentId !== normalizeAgentId(database.agentId)) ||
      (parsed && parsed.rest === "main" && canonicalMainKey !== "main")
    ) {
      throw nonCanonicalSessionKeyRowError(trimmed || row.session_key);
    }
    for (const lineageKey of [row.parent_session_key, row.spawned_by]) {
      if (!lineageKey) {
        continue;
      }
      const normalized = normalizeStoreSessionKey(lineageKey);
      const lineageParsed = parseAgentSessionKey(normalized);
      if (
        normalized !== lineageKey ||
        (!lineageParsed && normalized !== "global" && normalized !== "unknown") ||
        (lineageParsed?.rest === "main" && canonicalMainKey !== "main")
      ) {
        throw nonCanonicalSessionKeyRowError(normalized || lineageKey);
      }
    }
  }
  if (!database.db.isTransaction) {
    validatedDatabases.set(database.db, { mainKey: canonicalMainKey, token });
  }
  return token;
}

export function setCanonicalSqliteSessionMainKey(
  database: { db: DatabaseSync },
  mainKey: string | undefined,
): void {
  const canonicalMainKey = normalizeMainKey(mainKey);
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const currentMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  if (currentMainKey === canonicalMainKey) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_key_contract")
      .values({ id: 1, main_key: canonicalMainKey, updated_at: Date.now() })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          main_key: canonicalMainKey,
          updated_at: Date.now(),
        }),
      ),
  );
}

export function canonicalSqliteSessionKeyTokenIsCurrent(
  database: { db: DatabaseSync },
  token: CanonicalSessionKeyToken,
): boolean {
  return canonicalSessionKeyTokensEqual(token, readCanonicalSessionKeyToken(database.db));
}

export function mergeCanonicalSessionEntryCandidates<T>(
  candidates: readonly { entry: SessionEntry; preferred?: boolean; value: T }[],
): { entry: SessionEntry; winner: T } | undefined {
  let selected: { entry: SessionEntry; preferred: boolean; winner: T } | undefined;
  for (const candidate of candidates) {
    if (!selected) {
      selected = {
        entry: structuredClone(candidate.entry),
        preferred: candidate.preferred === true,
        winner: candidate.value,
      };
      continue;
    }
    const incomingUpdatedAt = Number.isFinite(candidate.entry.updatedAt)
      ? candidate.entry.updatedAt
      : 0;
    const selectedUpdatedAt = Number.isFinite(selected.entry.updatedAt)
      ? selected.entry.updatedAt
      : 0;
    const incomingWins =
      incomingUpdatedAt > selectedUpdatedAt ||
      (incomingUpdatedAt === selectedUpdatedAt &&
        (candidate.preferred === true
          ? !selected.preferred
          : !selected.preferred &&
            JSON.stringify(candidate.entry).localeCompare(JSON.stringify(selected.entry)) > 0));
    if (incomingWins) {
      selected = {
        entry: structuredClone(candidate.entry),
        preferred: candidate.preferred === true,
        winner: candidate.value,
      };
    }
  }
  return selected;
}
