import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

export const PERSONAL_SCOPE = "session-workspace-personal-publication";
export class SessionWorkspaceReservationBusyError extends Error {}
export const workspaceReservationQuery = (db: DatabaseSync) =>
  getNodeSqliteKysely<
    Pick<
      DB,
      "state_leases" | "worker_workspace_pending_results" | "worker_workspace_reconciliations"
    >
  >(db);

/** Run admission and placement movement consult the same SQLite exclusion as publishers. */
export function assertSessionWorkspaceUnreserved(db: DatabaseSync, sessionId: string): void {
  if (
    executeSqliteQueryTakeFirstSync(
      db,
      workspaceReservationQuery(db)
        .selectFrom("state_leases")
        .select("owner")
        .where("scope", "=", PERSONAL_SCOPE)
        .where("lease_key", "=", sessionId)
        .where("expires_at", ">", Date.now()),
    )
  ) {
    throw new SessionWorkspaceReservationBusyError(
      "The session workspace is being published; wait for publication to finish and retry.",
    );
  }
}
