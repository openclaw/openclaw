import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

export const PERSONAL_SCOPE = "session-workspace-personal-publication";
export class SessionWorkspaceReservationBusyError extends Error {}
const workspaceReservationQuery = (db: EngineConnection) =>
  getNodeSqliteKysely<
    Pick<
      DB,
      | "state_leases"
      | "worker_session_placements"
      | "worker_workspace_pending_results"
      | "worker_workspace_reconciliations"
    >
  >(db);

/** Run admission and placement movement consult the same SQLite exclusion as publishers. */
export function selectActiveSessionWorkspaceReservation(db: EngineConnection, sessionId: string) {
  return workspaceReservationQuery(db)
    .selectFrom("state_leases")
    .select("owner")
    .where("scope", "=", PERSONAL_SCOPE)
    .where("lease_key", "=", sessionId)
    .where("expires_at", ">", Date.now());
}

export function assertSessionWorkspaceUnreserved(db: EngineConnection, sessionId: string): void {
  if (executeSqliteQueryTakeFirstSync(db, selectActiveSessionWorkspaceReservation(db, sessionId))) {
    throw new SessionWorkspaceReservationBusyError(
      "The session workspace is being published; wait for publication to finish and retry.",
    );
  }
}
