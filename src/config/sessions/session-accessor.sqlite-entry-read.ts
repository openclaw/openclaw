import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import type { Selectable } from "kysely";
import {
  getNodeSqliteKysely,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  prepareSqliteQueryTakeFirstSync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import {
  hasSqliteSessionOwnerColumns,
  type SqliteSessionOwnerRow,
} from "./session-accessor.sqlite-owner-projection.js";
import {
  prepareSqliteSessionParticipantProjection,
  projectSqliteSessionParticipants,
  projectSqliteSessionParticipantsBatch,
} from "./session-accessor.sqlite-participant-projection.js";
import {
  parseSessionEntryJson as parseSessionEntryRow,
  selectSessionEntryRows,
} from "./session-accessor.sqlite-status.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import {
  collectSessionEntryLookupKeys,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_nodes"]>;

function prepareExactSessionEntryQueries(database: DatabaseSync) {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
  const metadataQueries = new Map<
    boolean,
    (key: string) => ResolvedSessionEntryRow["row"] | undefined
  >();
  return {
    row: prepareSqliteQueryTakeFirstSync<string, SessionEntryRow>(database, (parameter) =>
      db
        .selectFrom("session_nodes")
        .selectAll()
        .where(
          "session_key",
          "=",
          parameter((key) => key),
        ),
    ),
    json: prepareSqliteQueryTakeFirstSync<string, Pick<SessionEntryRow, "entry_json">>(
      database,
      (parameter) =>
        db
          .selectFrom("session_nodes")
          .select("entry_json")
          .where(
            "session_key",
            "=",
            parameter((key) => key),
          ),
    ),
    metadata: (key: string) => {
      const ownerColumns = hasSqliteSessionOwnerColumns(database);
      let query = metadataQueries.get(ownerColumns);
      if (!query) {
        query = prepareSqliteQueryTakeFirstSync<string, ResolvedSessionEntryRow["row"]>(
          database,
          (parameter) =>
            selectSessionEntryRows({ db: database }, "list", [], ownerColumns)
              .select(["current_session_id", "updated_at"])
              .select((eb) => eb.cast<string>("session_nodes.rowid", "text").as("rowid"))
              .where(
                "session_key",
                "=",
                parameter((value) => value),
              ),
        );
        metadataQueries.set(ownerColumns, query);
      }
      return query(key);
    },
  };
}

// Compile fixed reads once per connection; the shared executor still owns fresh
// bindings, statement invalidation, and schema-driven SELECT * repreparation.
const exactSessionEntryQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareExactSessionEntryQueries>
>();

function getExactSessionEntryQueries(database: DatabaseSync) {
  let queries = exactSessionEntryQueries.get(database);
  if (!queries) {
    queries = prepareExactSessionEntryQueries(database);
    exactSessionEntryQueries.set(database, queries);
  }
  return queries;
}

export type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  row: Pick<SessionEntryRow, "current_session_id" | "entry_json" | "session_key" | "updated_at"> &
    SqliteSessionOwnerRow & { rowid?: string } & Partial<
      Pick<SessionEntryRow, "legacy_acp_migration_json">
    >;
};

function parseReadableSessionEntryData(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: ResolvedSessionEntryRow["row"],
  projection: "full" | "list",
): SessionEntry | null {
  const parsed = parseSessionEntryRow(row, projection);
  if (parsed) {
    return parsed;
  }
  const retainedWindow =
    row.entry_json === "{}"
      ? executeSqliteQueryTakeFirstSync(
          database.db,
          getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
            .selectFrom("session_windows")
            .select("session_id")
            .where("session_id", "=", row.current_session_id)
            .where("session_key", "=", row.session_key),
        )
      : undefined;
  if (retainedWindow) {
    return null;
  }
  throw canonicalSessionKeyMigrationRequiredError(
    `invalid persisted session row requires repair for ${row.session_key}`,
  );
}

export function validateDeliveryCanonicalSessionEntry(
  sessionKey: string,
  entry: SessionEntry,
): SessionEntry {
  if (resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry) !== sessionKey) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${sessionKey}`,
    );
  }
  return entry;
}

/** Decodes a fresh owned entry, including its nested JSON, owner and participant values. */
export function parseReadableSqliteSessionEntryRow(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: ResolvedSessionEntryRow["row"],
  projection: "full" | "list" = "full",
): SessionEntry | null {
  const parsed = parseReadableSessionEntryData(database, row, projection);
  return parsed
    ? validateDeliveryCanonicalSessionEntry(
        row.session_key,
        projectSqliteSessionParticipants(database.db, row.session_key, parsed),
      )
    : null;
}

/** Projects one selected row set without repeating participant reads for each entry. */
export function parseReadableSqliteSessionEntryRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  rows: readonly ResolvedSessionEntryRow["row"][],
  projection: "full" | "list" = "full",
): SessionEntrySummary[] {
  const parsedEntries = new Map<string, SessionEntry>();
  for (const row of rows) {
    const entry = parseReadableSessionEntryData(database, row, projection);
    if (entry) {
      parsedEntries.set(row.session_key, entry);
    }
  }
  if (parsedEntries.size === 0) {
    return [];
  }
  return [...projectSqliteSessionParticipantsBatch(database.db, parsedEntries)].map(
    ([sessionKey, entry]) => ({
      sessionKey,
      entry: validateDeliveryCanonicalSessionEntry(sessionKey, entry),
    }),
  );
}

export function readSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  return readSessionEntryRowScan(database, sessionKey)?.selected;
}

/**
 * Reads the selected row plus every raw row the lookup scanned. A write transaction that must
 * prove this logical row is unchanged can re-read and compare the raw rows instead of decoding
 * the entry JSON again.
 */
export function readSessionEntryRowScan(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
):
  | {
      lookupKeys: string[];
      rows: SessionEntryRow[];
      selected: ResolvedSessionEntryRow | undefined;
    }
  | undefined {
  assertCanonicalSqliteSessionKeysCurrent(database);
  const lookupKeys = collectSessionEntryLookupKeys(database, sessionKey);
  const firstLookupKey = lookupKeys[0];
  if (firstLookupKey === undefined) {
    return undefined;
  }
  let rows: SessionEntryRow[];
  if (lookupKeys.length === 1) {
    const row = getExactSessionEntryQueries(database.db).row(firstLookupKey);
    rows = row ? [row] : [];
  } else {
    rows = executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
        .selectFrom("session_nodes")
        .selectAll()
        .where("session_key", "in", lookupKeys)
        .orderBy("session_key", "asc"),
    ).rows;
  }
  let selected: ResolvedSessionEntryRow | undefined;
  for (const row of rows) {
    const entry = parseReadableSqliteSessionEntryRow(database, row);
    if (!entry || row.session_key !== sessionKey.trim()) {
      continue;
    }
    selected = { entry, row };
  }
  return { lookupKeys, rows, selected };
}

export function readExactSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: "full" | "list" = "full",
): ResolvedSessionEntryRow | undefined {
  const row =
    projection === "list"
      ? getExactSessionEntryQueries(database.db).metadata(sessionKey)
      : getExactSessionEntryQueries(database.db).row(sessionKey);
  if (!row) {
    return undefined;
  }
  const entry = parseReadableSqliteSessionEntryRow(database, row, projection);
  return entry ? { entry, row } : undefined;
}

/** Capture exact rows once; failed cohort acquisition retains single-key error isolation. */
export function prepareExactSessionEntryRowReads(
  database: OpenClawAgentDatabaseReader,
  sessionKeys: readonly string[],
  projection: "full" | "list" = "full",
): (sessionKey: string) => ResolvedSessionEntryRow | undefined {
  let rows: ResolvedSessionEntryRow["row"][];
  try {
    const query =
      projection === "list"
        ? selectSessionEntryRows(database, projection).select(["current_session_id", "updated_at"])
        : getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
            .selectFrom("session_nodes")
            .selectAll();
    rows = executeSqliteQuerySync(
      database.db,
      query.where("session_key", "in", sqliteStringSet(sessionKeys)),
    ).rows;
  } catch {
    // Native conversion errors have no row identity; exact reads preserve each key's error.
    return (sessionKey) => readExactSessionEntryRow(database, sessionKey, projection);
  }
  const byKey = new Map(rows.map((row) => [row.session_key, row]));
  const projectParticipants = prepareSqliteSessionParticipantProjection(
    database.db,
    rows.filter((row) => row.entry_json !== "{}").map((row) => row.session_key),
  );
  return (sessionKey) => {
    // Match node:sqlite parameter binding before looking up the returned row.
    const row = byKey.get(toUSVString(sessionKey));
    if (!row) {
      return undefined;
    }
    const parsed = parseReadableSessionEntryData(database, row, projection);
    if (!parsed) {
      return undefined;
    }
    const entry = validateDeliveryCanonicalSessionEntry(
      row.session_key,
      projectParticipants(row.session_key, parsed),
    );
    return { entry, row };
  };
}

export function readExactSessionEntryJson(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
): string | undefined {
  return getExactSessionEntryQueries(database.db).json(sessionKey)?.entry_json;
}

export function readExactSessionEntryRowValidated(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: "full" | "list" = "full",
): ResolvedSessionEntryRow | undefined {
  assertCanonicalSqliteSessionKeysCurrent(database);
  return readExactSessionEntryRow(database, sessionKey, projection);
}
