import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { sql, type Selectable } from "kysely";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { ExactSessionEntry, SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
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
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
  canonicalSessionValidationQuery,
  readWithCanonicalSessionAdmission,
} from "./session-canonical-key.js";
import {
  validateCanonicalSessionRowEntry,
  type CanonicalSessionValidationRow,
} from "./session-canonical-row.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import {
  sessionEntrySnapshotColumns,
  type SessionEntrySnapshotRow,
} from "./session-entry-snapshots.js";
import {
  collectSessionEntryLookupKeys,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_nodes"]> &
  SessionEntrySnapshotRow;

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
        .select(sessionEntrySnapshotColumns)
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
              .select(
                /* kysely-allow-raw: implicit SQLite rowid is absent from declared-column types. */
                sql<string>`CAST(session_nodes.rowid AS TEXT)`.as("rowid"),
              )
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
          canonicalSessionValidationQuery({ db: database }, { metadata: true })
            .$if(projection === "full", (selection) =>
              selection.select(sessionEntrySnapshotColumns),
            )
            .where(
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
const getExactSessionEntryQueries = createSqliteQueryCache(prepareExactSessionEntryQueries);

export type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  row: Pick<SessionEntryRow, "current_session_id" | "entry_json" | "session_key" | "updated_at"> &
    SqliteSessionOwnerRow &
    SessionEntrySnapshotRow & { rowid?: string } & Partial<
      Pick<SessionEntryRow, "legacy_acp_migration_json">
    >;
};

type ReadableSessionEntryRow = ResolvedSessionEntryRow["row"] &
  (CanonicalSessionValidationRow | { retained_window_id?: never });

function parseReadableSessionEntryData(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: ReadableSessionEntryRow,
  projection: "full" | "list" | "delivery",
): SessionEntry | null {
  const parsed: SessionEntry | null =
    projection === "delivery"
      ? parseSqliteSessionEntryRecord(row)
      : parseSessionEntryRow(row, projection);
  if (parsed) {
    validateDeliveryCanonicalSessionEntry(row.session_key, parsed);
  }
  if (row.retained_window_id !== undefined) {
    // The guard and decoded entry share one statement snapshot, including cold handles.
    validateCanonicalSessionRowEntry(row, parsed, "read");
    return parsed;
  }
  if (parsed) {
    if (projection === "delivery") {
      const { sessionId, updatedAt, delivery, groupId } = parsed;
      return { sessionId, updatedAt, delivery, groupId };
    }
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
  row: ReadableSessionEntryRow,
  projection: "full" | "list" = "full",
): SessionEntry | null {
  const parsed = parseReadableSessionEntryData(database, row, projection);
  return parsed ? projectSqliteSessionParticipants(database.db, row.session_key, parsed) : null;
}

/** Decode supplied rows in caller order while sharing their lazy participant acquisition. */
export function prepareSqliteSessionEntryRowDecoder(
  database: Pick<OpenClawAgentDatabase, "db">,
  rows: readonly ReadableSessionEntryRow[],
  projection: "full" | "list" | "delivery" = "full",
): (row: ReadableSessionEntryRow) => SessionEntry | null {
  const projectParticipants =
    projection === "delivery"
      ? (_key: string, entry: SessionEntry) => entry
      : prepareSqliteSessionParticipantProjection(
          database.db,
          rows.filter((row) => row.entry_json !== "{}").map((row) => row.session_key),
        );
  return (row) => {
    const parsed = parseReadableSessionEntryData(database, row, projection);
    return parsed ? projectParticipants(row.session_key, parsed) : null;
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
      entry,
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

function selectReadableSessionEntryRows(
  database: OpenClawAgentDatabaseReader,
  projection: "full" | "list" | "delivery",
) {
  if (projection === "delivery") {
    // Preserve raw JSON strings, including escaped surrogates. Duplicate keys, overdepth
    // JSON and literal NUL retain the existing parser's semantics through the fallback.
    const deliveryJson =
      /* kysely-allow-raw: bounded delivery projection of exact session rows. */ sql<string>`
      CASE WHEN json_valid(entry_json)
        AND json_type(entry_json, '$.sessionId') = 'text'
        AND json_type(entry_json, '$.updatedAt') IN ('integer', 'real')
        AND length(CAST(entry_json AS BLOB)) = length(CAST(printf('%s', entry_json) AS BLOB))
      THEN (SELECT CASE WHEN count(*) = count(DISTINCT key)
        THEN json_group_object(key, json(entry_json -> fullkey)) ELSE entry_json END
        FROM json_each(entry_json) WHERE key IN ('sessionId', 'updatedAt', 'delivery', 'groupId'))
      ELSE entry_json END`.as("entry_json");
    return getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
      .selectFrom("session_nodes")
      .select(["session_key", "current_session_id", "updated_at", deliveryJson]);
  }
  return projection === "list"
    ? selectSessionEntryRows(database, projection).select(["current_session_id", "updated_at"])
    : getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
        .selectFrom("session_nodes")
        .selectAll()
        .select(sessionEntrySnapshotColumns);
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
    const lookupKeys = collectSessionEntryLookupKeys(sessionKey);
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
      rows = executeSqliteQuerySync(
        database.db,
        selectReadableSessionEntryRows(database, projection)
          .where("session_key", "in", lookupKeys)
          .orderBy("session_key", "asc"),
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
    const row =
      validation === "canonical"
        ? queries.canonical(sessionKey, projection)
        : projection === "list"
          ? queries.metadata(sessionKey)
          : queries.row(sessionKey);
    if (!row) {
      return undefined;
    }
    const entry = parseReadableSqliteSessionEntryRow(database, row, projection);
    return entry ? { entry, row } : undefined;
  });
}

/** Capture exact rows once; failed cohort acquisition retains single-key error isolation. */
export function prepareExactSessionEntryRowReads(
  database: OpenClawAgentDatabaseReader,
  sessionKeys: readonly string[],
  projection: "full" | "list" | "delivery" = "full",
  validation?: "canonical",
): (sessionKey: string) => ResolvedSessionEntryRow | undefined {
  return runSqliteReadOperationSync(database.db, () => {
    let rows: ReadableSessionEntryRow[];
    try {
      rows = executeSqliteQuerySync(
        database.db,
        (validation === "canonical"
          ? canonicalSessionValidationQuery(database, { metadata: true })
              .select("session_nodes.updated_at")
              .$if(projection === "full", (query) => query.select(sessionEntrySnapshotColumns))
          : selectReadableSessionEntryRows(database, projection)
        ).where("session_nodes.session_key", "in", sqliteStringSet(sessionKeys)),
      ).rows;
    } catch {
      // Native conversion errors have no row identity; exact reads preserve each key's error.
      return (sessionKey) =>
        readExactSessionEntryRow(
          database,
          sessionKey,
          projection === "delivery" ? "list" : projection,
          validation,
        );
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

// SQLite's default trim removes only spaces; legacy ID matching used String.trim().
const SESSION_ID_TRIM_CHARACTERS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** Uses the native current-ID and trimmed legacy-ID winner order inside the reader owner. */
export function readSessionEntryByIdInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "path" | "db">,
  selection: { sessionId: string; projection?: SessionEntryReadScope["projection"] },
): ExactSessionEntry | undefined {
  return readWithCanonicalSessionAdmission(database, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const query = db.selectFrom("session_nodes").select("session_key").orderBy("session_key");
    // The common path uses the current-ID index. Only a miss scans for one
    // legacy ID, preserving listing order without materializing other entries.
    for (const trimLegacyId of [false, true]) {
      const matches = iterateSqliteQuerySync(
        database.db,
        trimLegacyId
          ? query.where((eb) =>
              eb(
                eb.fn<string>("trim", ["current_session_id", eb.val(SESSION_ID_TRIM_CHARACTERS)]),
                "=",
                selection.sessionId,
              ),
            )
          : query.where("current_session_id", "=", selection.sessionId),
      );
      for (const { session_key: sessionKey } of matches) {
        if (isInternalSessionEffectsKey(sessionKey)) {
          continue;
        }
        const selected = readExactSessionEntryRowValidated(
          database,
          sessionKey,
          selection.projection,
        );
        if (selected) {
          return { sessionKey, entry: selected.entry };
        }
      }
    }
    return undefined;
  });
}
