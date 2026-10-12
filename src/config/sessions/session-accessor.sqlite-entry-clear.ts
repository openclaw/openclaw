import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { retainLegacyAcpMigrationSourcesForEntry } from "./session-accessor.sqlite-acp-provenance.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { writeSessionEntrySnapshots } from "./session-entry-snapshots.js";
import { deriveSessionPredicateColumns } from "./session-predicate-columns.js";

/** Remove the logical entry while retaining its node-owned transcript windows. */
export function clearSqliteSessionEntryPreservingWindows(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  writeSessionEntrySnapshots(database, params.sessionKey, []);
  retainLegacyAcpMigrationSourcesForEntry(database.db, params.sessionKey, undefined);
  const db = getSessionKysely(database.db);
  const cleared = {
    current_session_id: params.sessionId,
    entry_json: "{}",
    ...deriveSessionPredicateColumns("{}"),
    session_started_at: null,
    entry_valid: -1,
    updated_at: params.updatedAt,
    status: null,
    created_at: null,
    created_via: null,
    created_actor_type: null,
    created_actor_id: null,
    project_id: null,
    parent_session_key: null,
    spawned_by: null,
    fork_source_session_key: null,
    fork_source_session_id: null,
    fork_source_entry_id: null,
    label: null,
    display_name: null,
    category: null,
    icon: null,
    pinned_at: null,
    archived_at: null,
    last_read_at: null,
    last_interaction_at: null,
    last_activity_at: null,
    ...(hasSqliteSessionOwnerColumns(database.db)
      ? {
          owner_actor_type: null,
          owner_actor_id: null,
          owner_assigned_by_type: null,
          owner_assigned_by_id: null,
          owner_assigned_at: null,
        }
      : {}),
  } as const;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values({ session_key: params.sessionKey, ...cleared })
      .onConflict((conflict) => conflict.column("session_key").doUpdateSet(cleared)),
  );
}
