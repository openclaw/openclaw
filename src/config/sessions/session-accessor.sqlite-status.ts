import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryStatus,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import {
  hasSqliteSessionOwnerColumns,
  projectSqliteSessionOwner,
  type SqliteSessionOwnerRow,
} from "./session-accessor.sqlite-owner-projection.js";
import {
  hasValidSessionEntryIdentity,
  parseSqliteSessionEntryRecord,
} from "./session-entry-json.js";
import {
  attachSessionEntrySnapshots,
  sessionEntrySnapshotColumns,
  sessionEntrySnapshotColumnsForKeys,
  type SessionEntrySnapshotRow,
} from "./session-entry-snapshots.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

export function selectSessionEntryRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  projection: "full" | "list",
  fullEntryKeys: readonly string[] = [],
  // Prepared readers pass the column shape from this operation's fresh schema check.
  ownerColumns?: boolean,
) {
  return getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
    .selectFrom("session_nodes")
    .select("session_key")
    .select("entry_json")
    .$if(projection === "full" || fullEntryKeys.length > 0, (query) =>
      query.select(
        projection === "full"
          ? sessionEntrySnapshotColumns
          : sessionEntrySnapshotColumnsForKeys(fullEntryKeys),
      ),
    )
    .$if(ownerColumns ?? hasSqliteSessionOwnerColumns(database.db), (query) =>
      query.select([
        "owner_actor_type",
        "owner_actor_id",
        "owner_assigned_by_type",
        "owner_assigned_by_id",
        "owner_assigned_at",
      ]),
    );
}

// Canonical writers settle entry_valid; raw writes clear it. Inventory readers need
// no payload for settled rows, but must retain parser semantics for pending/retained rows.
export const sessionEntryInventoryJson =
  /* kysely-allow-raw: reuse the writer-owned validity projection without loading saved prompts. */ sql<
    string | null
  >`CASE WHEN entry_valid = 1 THEN NULL ELSE entry_json END`.as("entry_json");

export function normalizeStatus(value: unknown): SessionEntryStatus | null {
  // Keep canonical interruption distinct without changing the derived status index schema.
  if (value === "interrupted") {
    return "failed";
  }
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

export { hasValidSessionEntryIdentity };

export function parseSessionEntryJson(
  row: {
    current_session_id?: string;
    entry_json: string;
    updated_at?: number;
  } & SqliteSessionOwnerRow &
    SessionEntrySnapshotRow,
  projection: "full" | "list" = "full",
): SessionEntry | null {
  const record = parseSqliteSessionEntryRecord(row);
  if (!record) {
    return null;
  }
  if (projection === "list") {
    // Rejected legacy rows may retain unsplit fields; metadata views still omit them.
    delete record.sessionDiffBaseline;
    delete record.skillsSnapshot;
    delete record.systemPromptReport;
  } else {
    attachSessionEntrySnapshots(record, row);
  }
  return projectSqliteSessionOwner(projectCanonicalSessionEntryShape(record), row);
}

export function hasSessionEntriesByStatus(
  database: Pick<OpenClawAgentDatabase, "db">,
  statuses: readonly SessionEntryStatus[],
): boolean {
  const selectedStatuses = new Set(statuses);
  const projectedStatuses = [...new Set(statuses.map(normalizeStatus))].filter(
    (status): status is SessionEntryStatus => status !== null,
  );
  if (projectedStatuses.length === 0) {
    return false;
  }
  const query = selectSessionEntryRows(database, "list").where("status", "in", projectedStatuses);
  for (const row of iterateSqliteQuerySync(database.db, query)) {
    const entry = parseSessionEntryJson(row, "list");
    if (entry?.status && selectedStatuses.has(entry.status)) {
      return true;
    }
  }
  return false;
}

export function readSessionEntriesByStatus(
  database: OpenClawAgentDatabase,
  statuses: readonly SessionEntryStatus[],
  sessionKeys?: readonly string[],
): SessionEntrySummary[] {
  const selectedStatuses = [...new Set(statuses)];
  const projectedStatuses = [...new Set(selectedStatuses.map(normalizeStatus))].filter(
    (status): status is SessionEntryStatus => status !== null,
  );
  if (selectedStatuses.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
  let query = db
    .selectFrom("session_nodes")
    .selectAll()
    .select(sessionEntrySnapshotColumns)
    .where("status", "in", projectedStatuses);
  if (sessionKeys) {
    query = query.where("session_key", "in", sqliteStringSet(sessionKeys));
  }
  return executeSqliteQuerySync(database.db, query)
    .rows.flatMap((row) => {
      const entry = parseSessionEntryJson(row);
      return entry?.status && selectedStatuses.includes(entry.status)
        ? [{ entry, sessionKey: row.session_key }]
        : [];
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
