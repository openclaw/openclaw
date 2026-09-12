import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { mapTaskFlowView } from "../tasks/task-domain-views.js";
import { normalizeRestoredFlowRecord } from "../tasks/task-flow-registry.records.js";
import {
  listTaskFlowRecordsForOwnerReadInDatabase,
  readTaskFlowRecord,
  listTaskFlowViewRecordsForOwnerInDatabase,
  readTaskFlowViewRecordInDatabase,
} from "../tasks/task-flow-registry.store.kernel.js";
import { isTerminalTaskFlow } from "../tasks/task-flow-registry.types.js";
import {
  findTaskRecordByRunIdForViewInDatabase,
  listTaskRecordsForFlowReadInDatabase,
  listTaskRecordsForOwnerReadInDatabase,
  readTaskViewRecordInDatabase,
} from "../tasks/task-registry.store.kernel.js";
import { summarizeTaskRecords } from "../tasks/task-registry.summary.js";
import { openOpenClawStateReadConnection } from "./openclaw-state-db-read-connection.js";
import type { OpenClawStateWorkerOperations } from "./openclaw-state-worker-contract.js";

/** Schema admission remains with the canonical state owner before this existing-only open. */
export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<OpenClawStateWorkerOperations> {
  const connection = openOpenClawStateReadConnection(context.databasePath, context.databasePath);
  const { db } = connection.database;
  const listFlows = (ownerKey: string) =>
    listTaskFlowRecordsForOwnerReadInDatabase(db, ownerKey).map(normalizeRestoredFlowRecord);
  const ownedFlow = (flow: ReturnType<typeof readTaskFlowRecord>, ownerKey: string) =>
    flow?.ownerKey.trim() === ownerKey ? normalizeRestoredFlowRecord(flow) : undefined;
  return {
    execute(command) {
      return runSqliteDeferredTransactionSync(db, () => {
        switch (command.type) {
          case "tasks.get":
            return readTaskViewRecordInDatabase(db, command.input.taskId);
          case "tasks.list":
            return listTaskRecordsForOwnerReadInDatabase(db, command.input.ownerKey);
          case "tasks.resolve": {
            const { ownerKey, token } = command.input;
            return {
              direct: readTaskViewRecordInDatabase(db, token),
              byRun: findTaskRecordByRunIdForViewInDatabase(db, token),
              related: listTaskRecordsForOwnerReadInDatabase(db, ownerKey, token),
            };
          }
          case "flows.list":
            return listFlows(command.input.ownerKey);
          case "flows.views":
            return listTaskFlowViewRecordsForOwnerInDatabase(db, command.input.ownerKey)
              .map(normalizeRestoredFlowRecord)
              .map(mapTaskFlowView);
          case "flows.summary": {
            const { ownerKey, flowId } = command.input;
            const flow = ownedFlow(readTaskFlowViewRecordInDatabase(db, flowId), ownerKey);
            return flow
              ? summarizeTaskRecords(listTaskRecordsForFlowReadInDatabase(db, flow.flowId))
              : undefined;
          }
          case "flows.read":
          case "flows.detail": {
            const { ownerKey, lookup, token } = command.input;
            const direct = token === undefined ? undefined : readTaskFlowRecord(db, token);
            let flow = ownedFlow(direct, ownerKey);
            if (
              !flow &&
              (lookup === "latest" || (lookup === "resolve" && token?.trim() === ownerKey))
            ) {
              const flows = listFlows(ownerKey);
              flow =
                lookup === "resolve"
                  ? (flows.find((candidate) => !isTerminalTaskFlow(candidate)) ?? flows[0])
                  : flows[0];
            }
            if (!flow) {
              return undefined;
            }
            return command.type === "flows.detail"
              ? { flow, tasks: listTaskRecordsForFlowReadInDatabase(db, flow.flowId) }
              : flow;
          }
          default:
            throw new Error("Unknown shared-state SQLite command");
        }
      });
    },
    close() {
      connection.close();
    },
  };
}
