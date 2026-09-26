import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getRequired } from "./placement-row-codec.js";
import { createPlacementTurnClaimOps } from "./placement-turn-claims.js";
import type {
  PlacementTurnClaimReceipt,
  PlacementTurnClaimWorkerOperations,
} from "./placement-turn-claims.worker-contract.js";

export function executePlacementTurnClaimCommand(
  command: SqliteWorkerCommand<PlacementTurnClaimWorkerOperations>,
  database: OpenClawStateDatabase,
): PlacementTurnClaimReceipt {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const claims = createPlacementTurnClaimOps({
        path: database.path,
        instanceId: "",
        now: () => command.input.nowMs ?? Date.now(),
        read: () => db,
        write: (operation) => operation(db),
      });
      let receipt: PlacementTurnClaimReceipt;
      if (command.type === "placementTurns.claim") {
        const claim = claims.claimTurn(command.input.claim);
        receipt = { claim, placement: getRequired(db, claim.sessionId) };
      } else if (
        command.type === "placementTurns.releaseIfOwned" &&
        !claims.validateTurnClaim(command.input.claim)
      ) {
        receipt = {};
      } else {
        receipt = { placement: claims.releaseTurn(command.input.claim) };
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
      deferSqliteWorkerCommitReceipt(db, receipt);
      return receipt;
    },
    { database },
    { operationLabel: command.type },
  );
}
