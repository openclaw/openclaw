import { sql } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
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
  type SessionEntryProjection,
} from "./session-entry-snapshot-values.js";
import {
  sessionEntrySnapshotColumnsForKeys,
  type SessionEntrySnapshotRow,
} from "./session-entry-snapshots.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

export function selectSessionEntryRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  projection: SessionEntryProjection,
  fullEntryKeys: readonly string[] = [],
  // Prepared readers pass the column shape from this operation's fresh schema check.
  ownerColumns?: boolean,
) {
  return getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
    .selectFrom("session_nodes")
    .select("session_key")
    .select("entry_json")
    .$if(projection !== "list" || fullEntryKeys.length > 0, (query) =>
      query.select(
        projection === "list"
          ? sessionEntrySnapshotColumnsForKeys(fullEntryKeys)
          : sessionEntrySnapshotColumnsForKeys(undefined, projection),
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

// Canonical writers persist validated entry identity. Inventory readers need
// no payload for settled rows, but must retain parser semantics for pending/retained rows.
export const sessionEntryInventoryJson =
  /* kysely-allow-raw: reuse the writer-owned validity projection without loading saved prompts. */ sql<
    string | null
  >`CASE WHEN entry_valid = 1 THEN NULL ELSE entry_json END`.as("entry_json");

export function normalizeStatus(value: unknown): NonNullable<SessionEntry["status"]> | null {
  // Keep canonical interruption distinct without changing the derived status index schema.
  if (value === "interrupted") {
    return "failed";
  }
  return value === "done" || value === "failed" || value === "killed" || value === "timeout"
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
  projection: SessionEntryProjection = "full",
): SessionEntry | null {
  const record = parseSqliteSessionEntryRecord(row);
  if (!record) {
    return null;
  }
  attachSessionEntrySnapshots(record, row, projection);
  return projectSqliteSessionOwner(projectCanonicalSessionEntryShape(record), row);
}
