import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { jsonObjectFrom } from "kysely/helpers/sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  fromRow,
  revivePlacementProjectionInteger,
  selectWorkerPlacementRows,
} from "./placement-row-codec.js";

export const PERSONAL_SCOPE = "session-workspace-personal-publication";
export class SessionWorkspaceReservationBusyError extends Error {}
const workspaceReservationQuery = (db: DatabaseSync) =>
  getNodeSqliteKysely<
    Pick<
      DB,
      | "state_leases"
      | "worker_session_placements"
      | "worker_workspace_pending_results"
      | "worker_workspace_reconciliations"
    >
  >(db);

/** A missing placement must still expose orphaned result and reconciliation rows. */
export function readWorkspaceReservationAuthority(db: DatabaseSync, sessionId: string) {
  const query = workspaceReservationQuery(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query.selectNoFrom((eb) => [
      jsonObjectFrom(selectWorkerPlacementRows(db, [sessionId]))
        .$castTo<string | null>()
        .as("placement"),
      eb
        .exists(
          query
            .selectFrom("worker_workspace_pending_results")
            .select("session_id")
            .where("session_id", "=", sessionId),
        )
        .as("pending"),
      eb
        .exists(
          query
            .selectFrom("worker_workspace_reconciliations")
            .select("session_id")
            .where("session_id", "=", sessionId),
        )
        .as("reconciling"),
    ]),
  )!;
  return {
    placement:
      row.placement === null
        ? undefined
        : fromRow(
            // SAFETY: jsonObjectFrom serializes the typed complete row; fromRow validates its state.
            JSON.parse(row.placement, revivePlacementProjectionInteger) as Selectable<
              DB["worker_session_placements"]
            >,
          ),
    pending: Boolean(row.pending),
    reconciling: Boolean(row.reconciling),
  };
}

/** Run admission and placement movement consult the same SQLite exclusion as publishers. */
export function selectActiveSessionWorkspaceReservation(db: DatabaseSync, sessionId: string) {
  return workspaceReservationQuery(db)
    .selectFrom("state_leases")
    .select("owner")
    .where("scope", "=", PERSONAL_SCOPE)
    .where("lease_key", "=", sessionId)
    .where("expires_at", ">", Date.now());
}

export function assertSessionWorkspaceUnreserved(db: DatabaseSync, sessionId: string): void {
  if (executeSqliteQueryTakeFirstSync(db, selectActiveSessionWorkspaceReservation(db, sessionId))) {
    throw new SessionWorkspaceReservationBusyError(
      "The session workspace is being published; wait for publication to finish and retry.",
    );
  }
}
