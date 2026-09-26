import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";
import type { createPlacementTurnClaimOps } from "./placement-turn-claims.js";

type Claims = ReturnType<typeof createPlacementTurnClaimOps>;
export type PlacementTurnClaimReceipt = {
  placement?: WorkerSessionPlacementRecord;
  claim?: WorkerSessionTurnClaim;
};
export type PlacementTurnClaimWorkerOperations = {
  "placementTurns.claim": {
    input: { claim: Parameters<Claims["claimTurn"]>[0]; nowMs?: number };
    output: PlacementTurnClaimReceipt;
  };
  "placementTurns.release": {
    input: { claim: WorkerSessionTurnClaim; nowMs?: number };
    output: PlacementTurnClaimReceipt;
  };
  "placementTurns.releaseIfOwned": {
    input: { claim: WorkerSessionTurnClaim; nowMs?: number };
    output: PlacementTurnClaimReceipt;
  };
};

export function isPlacementTurnClaimCommand(command: {
  type: PropertyKey;
}): command is SqliteWorkerCommand<PlacementTurnClaimWorkerOperations> {
  return (
    command.type === "placementTurns.claim" ||
    command.type === "placementTurns.release" ||
    command.type === "placementTurns.releaseIfOwned"
  );
}
