import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { expressionBuilder, sql, type Selectable, type SqlBool } from "kysely";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  getSqliteReadScopeRevision,
  runSqliteReadOperationSync,
  type SqliteReadScopeRevision,
} from "../../infra/sqlite-schema-facts.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
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
  sessionEntrySnapshotColumnsForKeys,
  type SessionEntryProjection,
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

function cacheSessionEntryQuery<Row extends ResolvedSessionEntryRow["row"]>(
  database: DatabaseSync,
  query: (key: string) => Row | undefined,
): (key: string) => Row | undefined {
  let last: { key: string; revision: SqliteReadScopeRevision; row: Row | undefined } | undefined;
  return (key) => {
    const revision = getSqliteReadScopeRevision(database);
    if (revision && last?.revision === revision && last.key === key) {
      return last.row && { ...last.row };
    }
    const row = query(key);
    last =
      revision && getSqliteReadScopeRevision(database) === revision
        ? { key, revision, row }
        : undefined;
    // Mutation snapshots and parsers own their row, never the retained SQL result.
    return row && { ...row };
  };
}

// Each query retains only its last exact row at the connection's admitted revision.
const getExactSessionEntryQueries = createSqliteQueryCache((database) => {
  const rowQueries = new Map<string, (key: string) => ResolvedSessionEntryRow["row"] | undefined>();
  const canonicalQueries = new Map<
    string,
    (key: string) => (CanonicalSessionValidationRow & ResolvedSessionEntryRow["row"]) | undefined
  >();
  return {
    row: (key: string, projection: SessionEntryProjection = "full") => {
      const shape = `${JSON.stringify(projection)}:${hasSqliteSessionOwnerColumns(database)}`;
      let query = rowQueries.get(shape);
      if (!query) {
        query = cacheSessionEntryQuery(
          database,
          prepareSqliteQueryTakeFirstSync<string, ResolvedSessionEntryRow["row"]>(
            database,
            (parameter) =>
              selectReadableSessionEntryRows({ db: database }, projection).where(
                "session_key",
                "=",
                parameter((value) => value),
              ),
          ),
        );
        rowQueries.set(shape, query);
      }
      return query(key);
    },
    canonical: (key: string, projection: SessionEntryProjection) => {
      const shape = `${JSON.stringify(projection)}:${hasSqliteSessionOwnerColumns(database)}`;
      let query = canonicalQueries.get(shape);
      if (!query) {
        query = cacheSessionEntryQuery(
          database,
          prepareSqliteQueryTakeFirstSync<
            string,
            CanonicalSessionValidationRow & ResolvedSessionEntryRow["row"]
          >(database, (parameter) =>
            canonicalSessionValidationQuery({ db: database }, { metadata: true })
              .select(sessionEntrySnapshotColumnsForKeys(undefined, projection))
              .where(
                "session_nodes.session_key",
                "=",
                parameter((value) => value),
              ),
          ),
        );
        canonicalQueries.set(shape, query);
      }
      return query(key);
    },
  };
});

export type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  row: Pick<SessionEntryRow, "current_session_id" | "entry_json" | "session_key" | "updated_at"> &
    SqliteSessionOwnerRow &
    SessionEntrySnapshotRow &
    Partial<Pick<SessionEntryRow, "legacy_acp_migration_json">> & {
      board_present?: SqlBool;
      member_ids_json?: string;
    };
};

type ReadableSessionEntryRow = ResolvedSessionEntryRow["row"] &
  (CanonicalSessionValidationRow | { retained_window_id?: never });

function parseReadableSessionEntryData(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: ReadableSessionEntryRow,
  projection: SessionEntryProjection | "delivery",
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
  const canonicalKey = resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry);
  if (canonicalKey !== sessionKey) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${canonicalKey}`,
    );
  }
  return entry;
}

/** Decodes a fresh owned entry, including its nested JSON, owner and participant values. */
export function parseReadableSqliteSessionEntryRow(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: ReadableSessionEntryRow,
  projection: SessionEntryProjection = "full",
): SessionEntry | null {
  const parsed = parseReadableSessionEntryData(database, row, projection);
  return parsed ? projectSqliteSessionParticipants(database.db, row.session_key, parsed) : null;
}

/** Decode supplied rows in caller order while sharing their lazy participant acquisition. */
export function prepareSqliteSessionEntryRowDecoder(
  database: Pick<OpenClawAgentDatabase, "db">,
  rows: readonly ReadableSessionEntryRow[],
  projection: SessionEntryProjection | "delivery" = "full",
  projectParticipants = true,
  onParticipantProjectionError?: (sessionKey: string) => void,
): (row: ReadableSessionEntryRow) => SessionEntry | null {
  const project =
    projection === "delivery" || !projectParticipants
      ? (_key: string, entry: SessionEntry) => entry
      : prepareSqliteSessionParticipantProjection(
          database.db,
          rows.filter((row) => row.entry_json !== "{}").map((row) => row.session_key),
        );
  return (row) => {
    const parsed = parseReadableSessionEntryData(database, row, projection);
    if (!parsed) {
      return null;
    }
    try {
      return project(row.session_key, parsed);
    } catch (error) {
      if (!onParticipantProjectionError) {
        throw error;
      }
      onParticipantProjectionError(row.session_key);
      return parsed;
    }
  };
}

/** Projects one selected row set without repeating participant reads for each entry. */
function parseReadableSqliteSessionEntryRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  rows: readonly ResolvedSessionEntryRow["row"][],
  projection: SessionEntryProjection = "full",
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

/** Reuse the caller's admitted connection without reopening its read scope. */
export function readSessionKeyBySessionIdInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): string | undefined {
  // session_windows.session_id is the primary key; the indexed lookup cannot be ambiguous.
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "=", sessionId)
      .limit(1),
  )?.session_key;
}

export function readSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: SessionEntryProjection = "full",
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
  database: Pick<OpenClawAgentDatabase, "db">,
  projection: SessionEntryProjection | "delivery",
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
  return projection !== "full"
    ? selectSessionEntryRows(database, projection).select(["current_session_id", "updated_at"])
    : getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
        .selectFrom("session_nodes")
        .selectAll()
        .select(sessionEntrySnapshotColumnsForKeys(undefined, projection));
}

function scanSessionEntryRows(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: SessionEntryProjection,
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
    const rows = readSelectedSessionEntryRows(database, lookupKeys, projection);
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

/** Indexed child metadata shared by native compatibility and the incognito actor. */
export function readSessionChildEntriesInDatabase(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: SessionEntryProjection = "full",
): SessionEntrySummary[] {
  const sessionKeys = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
    .selectFrom("session_nodes")
    .select("session_key");
  // Separate indexed lookups avoid a whole-store scan chosen for OR with ordering.
  const childKeys = sessionKeys
    .where("parent_session_key", "=", sessionKey)
    .union(sessionKeys.where("spawned_by", "=", sessionKey));
  const childRows = executeSqliteQuerySync(
    database.db,
    selectReadableSessionEntryRows(database, projection)
      .where("session_key", "in", childKeys)
      .where("session_key", "!=", sessionKey)
      .orderBy("session_key", "asc"),
  ).rows;
  return parseReadableSqliteSessionEntryRows(
    database,
    childRows.filter((row) => !isInternalSessionEffectsKey(row.session_key)),
    projection,
  );
}

export function readExactSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: SessionEntryProjection = "full",
  validation?: "canonical",
): ResolvedSessionEntryRow | undefined {
  return runSqliteReadOperationSync(database.db, () => {
    const queries = getExactSessionEntryQueries(database.db);
    const row =
      validation === "canonical"
        ? queries.canonical(sessionKey, projection)
        : queries.row(sessionKey, projection);
    if (!row) {
      return undefined;
    }
    const entry = parseReadableSqliteSessionEntryRow(database, row, projection);
    return entry ? { entry, row } : undefined;
  });
}

/** Single-key and cohort readers share the same row selection and ordering. */
function readSelectedSessionEntryRows(
  database: OpenClawAgentDatabaseReader,
  selection: string | readonly string[],
  projection: SessionEntryProjection | "delivery",
  validation?: "canonical",
  options?: { includeBoardPresence?: boolean; includeMembership?: boolean },
): ReadableSessionEntryRow[] {
  const key =
    typeof selection === "string" ? selection : selection.length === 1 ? selection[0] : undefined;
  if (
    key !== undefined &&
    projection !== "delivery" &&
    !options?.includeBoardPresence &&
    !options?.includeMembership
  ) {
    const queries = getExactSessionEntryQueries(database.db);
    const row =
      validation === "canonical"
        ? queries.canonical(key, projection)
        : queries.row(key, projection);
    return row ? [row] : [];
  }
  const baseQuery =
    validation === "canonical"
      ? canonicalSessionValidationQuery(database, { metadata: true })
          .select("session_nodes.updated_at")
          .select(
            sessionEntrySnapshotColumnsForKeys(
              undefined,
              projection === "delivery" ? "list" : projection,
            ),
          )
      : selectReadableSessionEntryRows(database, projection);
  const eb = expressionBuilder<OpenClawAgentKyselyDatabase, "session_nodes">();
  // Old stores have no board tables until first use; branch before compiling SQL.
  const boardQuery = options?.includeBoardPresence
    ? baseQuery.select(
        (tableExists(database.db, "board_widgets")
          ? eb.exists(
              eb
                .selectFrom("board_tabs")
                .select("session_key")
                .whereRef("board_tabs.session_key", "=", "session_nodes.session_key"),
            )
          : eb.lit(0)
        ).as("board_present"),
      )
    : baseQuery;
  const query = options?.includeMembership
    ? boardQuery.select((outer) =>
        outer
          .selectFrom("session_members")
          .select(({ fn }) =>
            fn.agg<string>("json_group_array", ["identity_id"]).orderBy("identity_id").as("ids"),
          )
          .whereRef("session_members.session_key", "=", "session_nodes.session_key")
          .$asScalar()
          .as("member_ids_json"),
      )
    : boardQuery;
  return executeSqliteQuerySync(
    database.db,
    (typeof selection === "string"
      ? query.where("session_nodes.session_key", "=", selection)
      : query.where("session_nodes.session_key", "in", sqliteStringSet(selection))
    ).orderBy("session_nodes.session_key", "asc"),
  ).rows;
}

/** Capture exact rows once; failed cohort acquisition retains single-key error isolation. */
export function prepareExactSessionEntryRowReads(
  database: OpenClawAgentDatabaseReader,
  sessionKeys: readonly string[],
  projection: SessionEntryProjection | "delivery" = "full",
  validation?: "canonical",
  options?: {
    includeBoardPresence?: boolean;
    includeMembership?: boolean;
    /** Commit receipts retain canonical metadata but withhold failed display projections. */
    onParticipantProjectionError?: (sessionKey: string) => void;
    projectParticipants?: false;
  },
): (sessionKey: string) => ResolvedSessionEntryRow | undefined {
  return runSqliteReadOperationSync(database.db, () => {
    const readRows = (selection: string | readonly string[]) =>
      readSelectedSessionEntryRows(database, selection, projection, validation, options);
    let rows: ReadableSessionEntryRow[];
    try {
      rows = readRows(sessionKeys);
    } catch {
      // Native conversion errors have no row identity; exact reads preserve each key's error.
      if (
        options?.includeBoardPresence ||
        options?.includeMembership ||
        options?.onParticipantProjectionError ||
        options?.projectParticipants === false
      ) {
        return (sessionKey) =>
          runSqliteReadOperationSync(database.db, () => {
            const row = readRows(sessionKey)[0];
            const entry =
              row &&
              (options.projectParticipants === false
                ? parseReadableSessionEntryData(database, row, projection)
                : prepareSqliteSessionEntryRowDecoder(
                    database,
                    [row],
                    projection === "delivery" ? "list" : projection,
                    true,
                    options.onParticipantProjectionError,
                  )(row));
            return row && entry ? { entry, row } : undefined;
          });
      }
      return (sessionKey) =>
        readExactSessionEntryRow(
          database,
          sessionKey,
          projection === "delivery" ? "list" : projection,
          validation,
        );
    }
    const byKey = new Map(rows.map((row) => [row.session_key, row]));
    const decodeRow = prepareSqliteSessionEntryRowDecoder(
      database,
      rows,
      projection,
      options?.projectParticipants !== false,
      options?.onParticipantProjectionError,
    );
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
  projection: SessionEntryProjection = "full",
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
    projection?: SessionEntryProjection;
  } = {},
): { entry: SessionEntry | null; row: ResolvedSessionEntryRow["row"] } | undefined {
  return runSqliteReadOperationSync(database.db, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const queries = getExactSessionEntryQueries(database.db);
    const rows = target.storeKeys.flatMap((key) => {
      const row = queries.row(key.trim(), options.projection);
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
  options: { allowCanonicalMove?: boolean; projection?: SessionEntryProjection } = {},
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
