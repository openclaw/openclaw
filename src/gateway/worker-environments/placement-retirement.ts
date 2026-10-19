import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { required, type WorkerSessionPlacementIdentity } from "./placement-record.js";
import { query, turnClaimValues } from "./placement-row-codec.js";
import { publishPlacementTurnClaimCleared } from "./placement-turn-authority.js";

const RETIRABLE_PLACEMENT_STATES = ["local", "requested", "reclaimed", "failed"] as const;

export type WorkerSessionPlacementRetirement = {
  sessionId: string;
  expectedState: (typeof RETIRABLE_PLACEMENT_STATES)[number];
  expectedGeneration: number;
};

export function retireWorkerSessionPlacement(
  db: EngineConnection,
  input: WorkerSessionPlacementRetirement,
  options: { onlyIfCurrent?: boolean } = {},
): WorkerSessionPlacementIdentity | undefined {
  const sessionId = required(input.sessionId, "session id");
  if (!RETIRABLE_PLACEMENT_STATES.some((state) => state === input.expectedState)) {
    throw new Error(`Cannot retire worker session placement from ${input.expectedState}`);
  }
  const result = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .deleteFrom("worker_session_placements")
      .where("session_id", "=", sessionId)
      .where("state", "=", input.expectedState)
      .where("transition_generation", "=", input.expectedGeneration)
      .where((eb) => eb.and(turnClaimValues(null)))
      .returning(["session_id as sessionId", "agent_id as agentId", "session_key as sessionKey"]),
  );
  if (!result) {
    if (options.onlyIfCurrent) {
      return undefined;
    }
    throw new Error(`Worker session placement ${sessionId} changed before retirement`);
  }
  publishPlacementTurnClaimCleared(db, sessionId, input.expectedState, true);
  return result;
}
