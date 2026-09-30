import { requestSessionEntryCurrentAdmission } from "../../config/sessions/session-entry-current-admission.worker.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { find, getRequired } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { createPlacementTurnClaimOps } from "./placement-turn-claims.js";
import type {
  PlacementTurnClaimReceipt,
  PlacementTurnClaimWorkerOperations,
} from "./placement-turn-claims.worker-contract.js";
import {
  createPlacementWorkspaceResultOps,
  recordStagedWorkerWorkspaceResult,
} from "./placement-workspace-result.js";

export function executePlacementTurnClaimCommand(
  command: SqliteWorkerCommand<PlacementTurnClaimWorkerOperations>,
  database: OpenClawStateDatabase,
): PlacementTurnClaimReceipt {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const guardedWorkspaceWrite =
        command.type === "placementTurns.updateWorkspaceBaseManifest" ||
        command.type === "placementTurns.recordStagedResult";
      const source = guardedWorkspaceWrite ? command.input.sessionEntryCurrentSource : undefined;
      const admit = (stage: "transaction" | "commit", facts: unknown) =>
        requestSessionEntryCurrentAdmission(source, { stage, facts }, { lookup: "logical" });
      admit(
        "transaction",
        guardedWorkspaceWrite ? { placement: find(db, command.input.claim.sessionId) } : undefined,
      );
      const runtime: PlacementStoreRuntime = {
        path: database.path,
        instanceId:
          command.type === "placementTurns.recoverWorkspace" ||
          command.type === "placementTurns.handoffRuntimeRefreshResult"
            ? command.input.gatewayInstanceId
            : "",
        now: () => command.input.nowMs ?? Date.now(),
        read: () => db,
        write: (operation) => operation(db),
      };
      const claims = createPlacementTurnClaimOps(runtime);
      let receipt: PlacementTurnClaimReceipt;
      if (command.type === "placementTurns.claim") {
        const claim = claims.claimTurn(command.input.claim);
        receipt = { claim, placement: getRequired(db, claim.sessionId) };
      } else if (command.type === "placementTurns.updateWorkspaceBaseManifest") {
        receipt = { placement: claims.updateWorkspaceBaseManifest(command.input) };
      } else if (command.type === "placementTurns.recordStagedResult") {
        recordStagedWorkerWorkspaceResult(
          db,
          command.input.claim,
          command.input.stagedResultRef,
          command.input.repositoryWorkspaceId,
        );
        receipt = { placement: getRequired(db, command.input.claim.sessionId) };
      } else if (command.type === "placementTurns.recoverWorkspace") {
        const results = createPlacementWorkspaceResultOps(runtime);
        results.markWorkspaceResultPending(command.input.claim);
        results.handoffWorkspaceResultRecovery(command.input.claim);
        receipt = { placement: getRequired(db, command.input.claim.sessionId) };
      } else if (command.type === "placementTurns.handoffRuntimeRefreshResult") {
        const placement = getRequired(db, command.input.claim.sessionId);
        if (
          placement.state !== "active" ||
          placement.generation !== command.input.expectedGeneration ||
          command.input.claim.owner.kind !== "worker"
        ) {
          throw new Error("Worker runtime refresh lost its workspace result owner");
        }
        createPlacementWorkspaceResultOps(runtime).handoffWorkspaceResultRecovery(
          command.input.claim,
        );
        receipt = { placement };
      } else if (
        command.type === "placementTurns.releaseIfOwned" &&
        !claims.validateTurnClaim(command.input.claim)
      ) {
        receipt = {};
      } else {
        receipt = { placement: claims.releaseTurn(command.input.claim) };
      }
      admit("commit", receipt);
      deferSqliteWorkerCommitReceipt(db, receipt);
      return receipt;
    },
    { database },
    { operationLabel: command.type },
  );
}
