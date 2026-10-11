import { toUSVString } from "node:util";
import { expressionBuilder } from "kysely";
import {
  getNodeSqliteKysely,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { ExactSessionEntry, SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import {
  getExactSessionEntryQueries,
  selectReadableSessionEntryRows,
} from "./session-accessor.sqlite-entry-query.js";
import {
  prepareSqliteSessionParticipantProjection,
  projectSqliteSessionParticipants,
  projectSqliteSessionParticipantsBatch,
} from "./session-accessor.sqlite-participant-projection.js";
import {
  selectSessionEntryWindowFacts,
  takeSessionEntryWindowFacts,
} from "./session-accessor.sqlite-provenance.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
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
  attachSessionEntrySnapshots,
  type SessionEntryProjection,
} from "./session-entry-snapshot-values.js";
import { sessionEntrySnapshotColumnsForKeys } from "./session-entry-snapshots.js";
import type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";
import {
  collectSessionEntryLookupKeys,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";

type ReadableSessionEntryRow = ResolvedSessionEntryRow["row"] &
  (CanonicalSessionValidationRow | { retained_window_id?: never });

export function parseReadableSessionEntryData(
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
  includeWindowFacts?: true,
): ResolvedSessionEntryRow | undefined {
  return scanSessionEntryRows(database, sessionKey, projection, true, includeWindowFacts)?.selected;
}

/** Identity preparation retains normal alias validation without loading participant display data. */
export function readSessionEntryIdentity(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): Pick<SessionEntry, "sessionId" | "updatedAt" | "lifecycleRevision"> | undefined {
  const entry = scanSessionEntryRows(database, sessionKey, "list", false)?.selected?.entry;
  return (
    entry && {
      sessionId: entry.sessionId,
      updatedAt: entry.updatedAt,
      lifecycleRevision: entry.lifecycleRevision,
    }
  );
}

/** Read the selected entry and the exact lookup rows in one owner snapshot. */
export function readSessionEntryRowScan(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  includeWindowFacts?: true,
) {
  return scanSessionEntryRows(database, sessionKey, "full", true, includeWindowFacts);
}

function scanSessionEntryRows(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: SessionEntryProjection,
  includeParticipants = true,
  includeWindowFacts?: true,
):
  | {
      lookupKeys: string[];
      rows: ResolvedSessionEntryRow["row"][];
      selected: ResolvedSessionEntryRow | undefined;
    }
  | undefined {
  const actor = readSessionActorTransactionState(database, { sessionKey });
  if (actor) {
    const lookupKeys = collectSessionEntryLookupKeys(sessionKey);
    return {
      lookupKeys,
      rows: lookupKeys.flatMap((key) => {
        const row = actor.entryRows.get(key)?.row;
        return row ? [structuredClone(row)] : [];
      }),
      selected: readExactSessionEntryRow(
        database,
        sessionKey,
        projection,
        undefined,
        includeWindowFacts,
      ),
    };
  }
  return runSqliteReadOperationSync(database.db, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const lookupKeys = collectSessionEntryLookupKeys(sessionKey);
    const firstLookupKey = lookupKeys[0];
    if (firstLookupKey === undefined) {
      return undefined;
    }
    const rows = readSelectedSessionEntryRows(
      database,
      lookupKeys,
      projection,
      undefined,
      includeWindowFacts
        ? { includeWindowFacts, includeBoardPresence: true, includeMembership: true }
        : undefined,
    );
    let selected: ResolvedSessionEntryRow | undefined;
    for (const row of rows) {
      const entry = includeParticipants
        ? parseReadableSqliteSessionEntryRow(database, row, projection)
        : parseReadableSessionEntryData(database, row, projection);
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

/** Final generation guards reuse an admitted native handle without freshness or schema queries. */
export function readSessionEntryGenerationInDatabase(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
):
  | Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "permissionMode" | "toolOverrides">
  | undefined {
  const row = getExactSessionEntryQueries(database.db).canonical(sessionKey, "list", false);
  const entry = row && parseReadableSessionEntryData(database, row, "list");
  if (!entry) {
    return undefined;
  }
  const { sessionId, lifecycleRevision, permissionMode, toolOverrides } = entry;
  return { sessionId, lifecycleRevision, permissionMode, toolOverrides };
}

export function readExactSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: SessionEntryProjection = "full",
  validation?: "canonical",
  includeWindowFacts?: true,
): ResolvedSessionEntryRow | undefined {
  const actor = readSessionActorTransactionState(database, { sessionKey });
  if (actor) {
    const selected = actor.entryRows.get(sessionKey);
    return (
      selected && {
        row: {
          ...structuredClone(selected.row),
          ...(includeWindowFacts
            ? {
                window: actor.window ? structuredClone(actor.window) : null,
                member_ids_json: JSON.stringify(
                  actor.hot.members.map((member) => member.identityId),
                ),
                board_present: actor.hasBoard ? 1 : 0,
              }
            : {}),
        },
        entry: attachSessionEntrySnapshots(structuredClone(selected.entry), {}, projection),
      }
    );
  }
  return runSqliteReadOperationSync(database.db, () => {
    const queries = getExactSessionEntryQueries(database.db);
    const row = includeWindowFacts
      ? readSelectedSessionEntryRows(database, sessionKey, projection, validation, {
          includeWindowFacts,
          includeBoardPresence: true,
          includeMembership: true,
        })[0]
      : validation === "canonical"
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
  options?: {
    includeBoardPresence?: boolean;
    includeMembership?: boolean;
    includeWindowFacts?: true;
  },
): ReadableSessionEntryRow[] {
  const key =
    typeof selection === "string" ? selection : selection.length === 1 ? selection[0] : undefined;
  if (
    key !== undefined &&
    projection !== "delivery" &&
    !options?.includeBoardPresence &&
    !options?.includeMembership &&
    !options?.includeWindowFacts
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
  const windowQuery = options?.includeWindowFacts
    ? baseQuery
        .leftJoin(
          selectSessionEntryWindowFacts(database),
          "entry_window.window_session_id",
          "session_nodes.current_session_id",
        )
        .selectAll("entry_window")
    : baseQuery;
  const eb = expressionBuilder<OpenClawAgentKyselyDatabase, "session_nodes">();
  // Old stores have no board tables until first use; branch before compiling SQL.
  const boardQuery = options?.includeBoardPresence
    ? windowQuery.select(
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
    : windowQuery;
  const query = options?.includeMembership
    ? boardQuery.select((outer) =>
        tableExists(database.db, "session_members")
          ? outer
              .selectFrom("session_members")
              .select(({ fn }) =>
                fn
                  .agg<string>("json_group_array", ["identity_id"])
                  .orderBy("identity_id")
                  .as("ids"),
              )
              .whereRef("session_members.session_key", "=", "session_nodes.session_key")
              .$asScalar()
              .as("member_ids_json")
          : outer.val("[]").as("member_ids_json"),
      )
    : boardQuery;
  const rows = executeSqliteQuerySync(
    database.db,
    (typeof selection === "string"
      ? query.where("session_nodes.session_key", "=", selection)
      : query.where("session_nodes.session_key", "in", sqliteStringSet(selection))
    ).orderBy("session_nodes.session_key", "asc"),
  ).rows;
  return options?.includeWindowFacts
    ? rows.map((row) => {
        const window = takeSessionEntryWindowFacts(row);
        return { ...row, window };
      })
    : rows;
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
    includeWindowFacts?: true;
    /** Commit receipts retain canonical metadata but withhold failed display projections. */
    onParticipantProjectionError?: (sessionKey: string) => void;
    projectParticipants?: false;
  },
): (sessionKey: string) => ResolvedSessionEntryRow | undefined {
  const actor = readSessionActorTransactionState(database);
  if (
    actor &&
    projection !== "delivery" &&
    sessionKeys.every(
      (key) =>
        actor.entryRows.has(key) &&
        (key === actor.hot.target.sessionKey || !actor.entryRows.get(key)),
    )
  ) {
    return (sessionKey) => {
      const selected = readExactSessionEntryRow(
        database,
        sessionKey,
        projection,
        validation,
        options?.includeWindowFacts,
      );
      if (selected) {
        if (options?.includeBoardPresence) {
          selected.row.board_present = actor.hasBoard ? 1 : 0;
        }
        if (options?.includeMembership) {
          selected.row.member_ids_json = JSON.stringify(
            actor.hot.members.map((member) => member.identityId),
          );
        }
      }
      return selected;
    };
  }
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
        options?.includeWindowFacts ||
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
    includeWindowFacts?: true;
  } = {},
): { entry: SessionEntry | null; row: ResolvedSessionEntryRow["row"] } | undefined {
  return runSqliteReadOperationSync(database.db, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const queries = getExactSessionEntryQueries(database.db);
    const rows = target.storeKeys.flatMap((key) => {
      const row = options.includeWindowFacts
        ? readSelectedSessionEntryRows(
            database,
            key.trim(),
            options.projection ?? "full",
            undefined,
            {
              includeWindowFacts: true,
              includeMembership: true,
              includeBoardPresence: true,
            },
          )[0]
        : queries.row(key.trim(), options.projection);
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
  options: {
    allowCanonicalMove?: boolean;
    projection?: SessionEntryProjection;
    includeWindowFacts?: true;
  } = {},
) {
  const parsed = parseAgentSessionKey(sessionKey);
  const sentinel = parsed?.rest ?? sessionKey;
  if (
    agentId !== database.agentId ||
    (parsed && parsed.agentId !== agentId) ||
    (sentinel !== "global" && sentinel !== "unknown")
  ) {
    return readSessionEntryRow(
      database,
      sessionKey,
      options.projection,
      options.includeWindowFacts,
    );
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
  selection: {
    sessionId: string;
    projection?: SessionEntryReadScope["projection"];
    orderBy?: "updatedAt";
  },
): ExactSessionEntry | undefined {
  return readWithCanonicalSessionAdmission(database, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const query = db
      .selectFrom("session_nodes")
      .select("session_key")
      .$if(selection.orderBy === "updatedAt", (ordered) => ordered.orderBy("updated_at", "desc"))
      .orderBy("session_key");
    // Default reads prefer indexed exact IDs; recency selection considers
    // trimmed legacy matches together so a newer alias can win.
    for (const trimLegacyId of selection.orderBy === "updatedAt" ? [true] : [false, true]) {
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
