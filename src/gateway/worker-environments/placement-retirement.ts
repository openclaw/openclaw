import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { required } from "./placement-record.js";
import { query } from "./placement-row-codec.js";
import { publishPlacementTurnClaimCleared } from "./placement-turn-authority.js";

const RETIRABLE_PLACEMENT_STATES = ["local", "requested", "reclaimed", "failed"] as const;

export type WorkerSessionPlacementRetirement = {
  sessionId: string;
  expectedState: (typeof RETIRABLE_PLACEMENT_STATES)[number];
  expectedGeneration: number;
};

export function retireWorkerSessionPlacement(
  db: DatabaseSync,
  input: WorkerSessionPlacementRetirement,
  options: { onlyIfCurrent?: boolean } = {},
): boolean {
  const sessionId = required(input.sessionId, "session id");
  if (!RETIRABLE_PLACEMENT_STATES.some((state) => state === input.expectedState)) {
    throw new Error(`Cannot retire worker session placement from ${input.expectedState}`);
  }
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("worker_session_placements")
      .where("session_id", "=", sessionId)
      .where("state", "=", input.expectedState)
      .where("transition_generation", "=", input.expectedGeneration)
      .where("turn_claim_owner", "is", null)
      .where("turn_claim_id", "is", null)
      .where("turn_claim_run_id", "is", null)
      .where("turn_claim_generation", "is", null)
      .where("turn_claim_owner_epoch", "is", null),
  );
  if (result.numAffectedRows !== 1n) {
    if (options.onlyIfCurrent) {
      return false;
    }
    throw new Error(`Worker session placement ${sessionId} changed before retirement`);
  }
  publishPlacementTurnClaimCleared(db, sessionId, input.expectedState, true);
  return true;
}
