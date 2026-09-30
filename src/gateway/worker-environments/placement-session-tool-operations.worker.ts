import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createPlacementSessionToolOperationKernel } from "./placement-session-tool-operations.kernel.js";
import type { PlacementSessionToolReceipt } from "./placement-session-tool-operations.receipt.js";
import type { PlacementSessionToolWorkerOperations } from "./placement-session-tool-operations.worker-contract.js";

export function executePlacementSessionToolCommand(
  command: SqliteWorkerCommand<PlacementSessionToolWorkerOperations>,
  database: OpenClawStateDatabase,
): PlacementSessionToolReceipt {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const tools = createPlacementSessionToolOperationKernel({
        db,
        instanceId: command.input.instanceId,
        now: () => command.input.nowMs ?? Date.now(),
      });
      const receipt: PlacementSessionToolReceipt = {};
      switch (command.type) {
        case "placementTools.authorize":
          receipt.toolNames = tools.authorize(...command.input.args);
          break;
        case "placementTools.seal":
          tools.seal(...command.input.args);
          receipt.toolNames = null;
          break;
        case "placementTools.clear":
          receipt.changed = tools.clear(...command.input.args);
          receipt.toolNames = null;
          break;
        case "placementTools.begin":
          receipt.result = tools.begin(...command.input.args);
          break;
        case "placementTools.bindChild":
          receipt.changed = tools.bindChild(...command.input.args);
          break;
        case "placementTools.complete":
          receipt.changed = tools.complete(...command.input.args);
          break;
        case "placementTools.abandon":
          receipt.changed = tools.abandon(...command.input.args);
          break;
        case "placementTools.recover":
          receipt.recovered = tools.recover();
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
      deferSqliteWorkerCommitReceipt(db, receipt);
      return receipt;
    },
    { database },
    { operationLabel: command.type },
  );
}
