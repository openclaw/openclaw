import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { fromRow, query, turnClaimValues } from "./placement-row-codec.js";
import { publishPlacementTurnClaimState } from "./placement-turn-authority.js";
import { deferTurnClaimRelease } from "./placement-turn-wait.js";

function clearLocalTurnClaimsInDatabase(
  db: EngineConnection,
  path: string,
  nowMs: number,
): WorkerSessionPlacementRecord[] {
  const placements = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_session_placements")
      .set({ ...turnClaimValues(null), updated_at_ms: nowMs })
      .where("turn_claim_owner", "=", "local")
      .returningAll(),
  ).rows.map(fromRow);
  for (const placement of placements) {
    publishPlacementTurnClaimState(db, placement, placement.state);
    deferTurnClaimRelease(db, path, placement.sessionId);
  }
  return placements;
}

export const placementRecoveryOperations = {
  "workerPlacements.clearLocalTurnClaims": (
    input: { nowMs?: number },
    { write }: WorkerWriteOperationContext,
  ) =>
    write(({ db, path }) => clearLocalTurnClaimsInDatabase(db, path, input.nowMs ?? Date.now()), {
      operationLabel: "workerPlacements.clearLocalTurnClaims",
    }),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
