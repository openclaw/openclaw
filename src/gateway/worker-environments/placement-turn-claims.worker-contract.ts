import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentSource,
} from "../../config/sessions/session-entry-current.types.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionTurnClaim,
  WorkerTurnClaimInput,
} from "./placement-record.js";
export type PlacementTurnClaimReceipt = {
  placement?: WorkerSessionPlacementRecord;
  claim?: WorkerSessionTurnClaim;
};
export type PlacementTurnClaimCurrentCheck = {
  sessionEntry?: SessionEntryCurrentCheck;
  assertPlacementCurrent(placement: WorkerSessionPlacementRecord | undefined): void;
};
export type PlacementTurnClaimWorkerOperations = {
  "placementTurns.updateWorkspaceBaseManifest": {
    input: {
      claim: WorkerSessionTurnClaim;
      manifestRef: string;
      nowMs?: number;
      sessionEntryCurrentSource?: SessionEntryCurrentSource;
    };
    output: PlacementTurnClaimReceipt;
  };
  "placementTurns.claim": {
    input: { claim: WorkerTurnClaimInput; nowMs?: number };
    output: PlacementTurnClaimReceipt;
  };
  "placementTurns.recordStagedResult": {
    input: {
      claim: WorkerSessionTurnClaim;
      stagedResultRef: string;
      repositoryWorkspaceId?: string;
      sessionEntryCurrentSource?: SessionEntryCurrentSource;
      nowMs?: number;
    };
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
  "placementTurns.recoverWorkspace": {
    input: { claim: WorkerSessionTurnClaim; gatewayInstanceId: string; nowMs?: number };
    output: PlacementTurnClaimReceipt;
  };
  "placementTurns.handoffRuntimeRefreshResult": {
    input: {
      claim: WorkerSessionTurnClaim;
      expectedGeneration: number;
      gatewayInstanceId: string;
      nowMs: number;
    };
    output: PlacementTurnClaimReceipt;
  };
};

export function isPlacementTurnClaimCommand(command: {
  type: PropertyKey;
}): command is SqliteWorkerCommand<PlacementTurnClaimWorkerOperations> {
  return (
    command.type === "placementTurns.updateWorkspaceBaseManifest" ||
    command.type === "placementTurns.claim" ||
    command.type === "placementTurns.recordStagedResult" ||
    command.type === "placementTurns.release" ||
    command.type === "placementTurns.releaseIfOwned" ||
    command.type === "placementTurns.recoverWorkspace" ||
    command.type === "placementTurns.handoffRuntimeRefreshResult"
  );
}
