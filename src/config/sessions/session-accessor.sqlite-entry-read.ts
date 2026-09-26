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
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
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
  canonicalSessionValidationQuery,
} from "./session-canonical-key.js";
import {
  validateCanonicalSessionRow,
  type CanonicalSessionValidationRow,
} from "./session-canonical-row.js";
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
  const canonicalQueries = new Map<
    string,
    (key: string) => (CanonicalSessionValidationRow & ResolvedSessionEntryRow["row"]) | undefined
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
    canonical: (key: string, projection: "full" | "list") => {
      const shape = `${projection}:${hasSqliteSessionOwnerColumns(database)}`;
      let query = canonicalQueries.get(shape);
      if (!query) {
        query = prepareSqliteQueryTakeFirstSync<
          string,
          CanonicalSessionValidationRow & ResolvedSessionEntryRow["row"]
        >(database, (parameter) =>
          canonicalSessionValidationQuery(
            { db: database },
            { fullEntries: projection === "full", metadata: true },
          ).where(
            "session_nodes.session_key",
            "=",
            parameter((value) => value),
          ),
        );
        canonicalQueries.set(shape, query);
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

/** Decode supplied rows in caller order while sharing their lazy participant acquisition. */
export function prepareSqliteSessionEntryRowDecoder(
  database: Pick<OpenClawAgentDatabase, "db">,
  rows: readonly ResolvedSessionEntryRow["row"][],
  projection: "full" | "list" = "full",
): (row: ResolvedSessionEntryRow["row"]) => SessionEntry | null {
  const projectParticipants = prepareSqliteSessionParticipantProjection(
    database.db,
    rows.filter((row) => row.entry_json !== "{}").map((row) => row.session_key),
  );
  return (row) => {
    const parsed = parseReadableSessionEntryData(database, row, projection);
    return parsed
      ? validateDeliveryCanonicalSessionEntry(
          row.session_key,
          projectParticipants(row.session_key, parsed),
        )
      : null;
  };
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
  projection: "full" | "list" = "full",
): ResolvedSessionEntryRow | undefined {
  return scanSessionEntryRows(database, sessionKey, projection)?.selected;
}

/**
 * Reads the selected row plus every raw row the lookup scanned. A write transaction that must
 * prove this logical row is unchanged can re-read and compare the raw rows instead of decoding
 * the entry JSON again.
 */
export function readSessionEntryRowScan(database: OpenClawAgentDatabaseReader, sessionKey: string) {
  // Mutation snapshots must retain every raw column, including the saved prompts.
  return scanSessionEntryRows(database, sessionKey, "full");
}

function scanSessionEntryRows(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: "full" | "list",
):
  | {
      lookupKeys: string[];
      rows: ResolvedSessionEntryRow["row"][];
      selected: ResolvedSessionEntryRow | undefined;
    }
  | undefined {
  return runSqliteReadOperationSync(database.db, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const lookupKeys = collectSessionEntryLookupKeys(database, sessionKey);
    const firstLookupKey = lookupKeys[0];
    if (firstLookupKey === undefined) {
      return undefined;
    }
    let rows: ResolvedSessionEntryRow["row"][];
    if (lookupKeys.length === 1) {
      const queries = getExactSessionEntryQueries(database.db);
      const row =
        projection === "list" ? queries.metadata(firstLookupKey) : queries.row(firstLookupKey);
      rows = row ? [row] : [];
    } else {
      const query =
        projection === "list"
          ? selectSessionEntryRows(database, projection).select([
              "current_session_id",
              "updated_at",
            ])
          : getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
              .selectFrom("session_nodes")
              .selectAll();
      rows = executeSqliteQuerySync(
        database.db,
        query.where("session_key", "in", lookupKeys).orderBy("session_key", "asc"),
      ).rows;
    }
    let selected: ResolvedSessionEntryRow | undefined;
    for (const row of rows) {
      const entry = parseReadableSqliteSessionEntryRow(database, row, projection);
      if (!entry || row.session_key !== sessionKey.trim()) {
        continue;
      }
      selected = { entry, row };
    }
    return { lookupKeys, rows, selected };
  });
}

export function readExactSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: "full" | "list" = "full",
  validation?: "canonical",
): ResolvedSessionEntryRow | undefined {
  return runSqliteReadOperationSync(database.db, () => {
    const queries = getExactSessionEntryQueries(database.db);
    const canonicalRow =
      validation === "canonical" ? queries.canonical(sessionKey, projection) : undefined;
    const row =
      validation === "canonical"
        ? canonicalRow
        : projection === "list"
          ? queries.metadata(sessionKey)
          : queries.row(sessionKey);
    if (!row) {
      return undefined;
    }
    const entry = parseReadableSqliteSessionEntryRow(database, row, projection);
    if (canonicalRow) {
      // The guard and decoded entry share one statement snapshot, including cold handles.
      validateCanonicalSessionRow(canonicalRow, "read");
    }
    return entry ? { entry, row } : undefined;
  });
}

/** Capture exact rows once; failed cohort acquisition retains single-key error isolation. */
export function prepareExactSessionEntryRowReads(
  database: OpenClawAgentDatabaseReader,
  sessionKeys: readonly string[],
  projection: "full" | "list" = "full",
): (sessionKey: string) => ResolvedSessionEntryRow | undefined {
  return runSqliteReadOperationSync(database.db, () => {
    let rows: ResolvedSessionEntryRow["row"][];
    try {
      const query =
        projection === "list"
          ? selectSessionEntryRows(database, projection).select([
              "current_session_id",
              "updated_at",
            ])
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
    const decodeRow = prepareSqliteSessionEntryRowDecoder(database, rows, projection);
    return (sessionKey) =>
      runSqliteReadOperationSync(database.db, () => {
        // Match node:sqlite parameter binding before looking up the returned row.
        const row = byKey.get(toUSVString(sessionKey));
        if (!row) {
          return undefined;
        }
        const entry = decodeRow(row);
        return entry ? { entry, row } : undefined;
      });
  });
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
  return runSqliteReadOperationSync(database.db, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    return readExactSessionEntryRow(database, sessionKey, projection);
  });
}

/** Select a physical row while refusing any other admitted spelling. */
export function readSessionEntryTargetRow(
  database: OpenClawAgentDatabaseReader,
  target: { canonicalKey: string; storeKeys: readonly string[] },
  options: {
    allowCanonicalMove?: boolean;
    guardRetainedWindows?: boolean;
    projection?: "full" | "list";
  } = {},
): { entry: SessionEntry | null; row: ResolvedSessionEntryRow["row"] } | undefined {
  return runSqliteReadOperationSync(database.db, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const queries = getExactSessionEntryQueries(database.db);
    const rows = target.storeKeys.flatMap((key) => {
      const row =
        options.projection === "list" ? queries.metadata(key.trim()) : queries.row(key.trim());
      if (!row) {
        return [];
      }
      const entry = parseReadableSqliteSessionEntryRow(database, row, options.projection);
      return entry || options.guardRetainedWindows ? [{ entry, row }] : [];
    });
    if (rows.length > 1) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${target.canonicalKey}`,
      );
    }
    const selected = rows[0];
    if (
      selected &&
      selected.row.session_key !== target.canonicalKey &&
      !options.allowCanonicalMove
    ) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${target.canonicalKey}`,
      );
    }
    return selected;
  });
}

/** Only sentinel aliases share a logical identity with a different physical key. */
export function readQualifiedSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  agentId: string,
  sessionKey: string,
  options: { allowCanonicalMove?: boolean; projection?: "full" | "list" } = {},
) {
  const parsed = parseAgentSessionKey(sessionKey);
  const sentinel = parsed?.rest ?? sessionKey;
  if (
    agentId !== database.agentId ||
    (parsed && parsed.agentId !== agentId) ||
    (sentinel !== "global" && sentinel !== "unknown")
  ) {
    return readSessionEntryRow(database, sessionKey, options.projection);
  }
  return readSessionEntryTargetRow(
    database,
    { canonicalKey: sessionKey, storeKeys: [sentinel, `agent:${agentId}:${sentinel}`] },
    { ...options, guardRetainedWindows: true },
  );
}
