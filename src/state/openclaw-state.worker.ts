import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
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
import {
  closeOpenClawStateDatabaseByPath,
  clearOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  openOpenClawStateDatabase({
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  return openExistingSqliteWorkerBackend(undefined, context);
}

export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  const open = () =>
    openOpenClawStateDatabase({
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  const listFlows = (db: ReturnType<typeof open>["db"], ownerKey: string) =>
    listTaskFlowRecordsForOwnerReadInDatabase(db, ownerKey).map(normalizeRestoredFlowRecord);
  const ownedFlow = (flow: ReturnType<typeof readTaskFlowRecord>, ownerKey: string) =>
    flow?.ownerKey.trim() === ownerKey ? normalizeRestoredFlowRecord(flow) : undefined;
  return {
    execute(command) {
      if (command.type === "database.generationMatches") {
        // Unavailable inspection retains the known failure; only a stable mismatch expires it.
        return sameSqliteFileGeneration(
          command.input.generation,
          readStableSqliteFileGeneration(context.databasePath),
        );
      }
      const { db } = open();
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
            return listFlows(db, command.input.ownerKey);
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
              const flows = listFlows(db, ownerKey);
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
      closeOpenClawStateDatabaseByPath(context.databasePath);
      clearOpenClawStateDatabaseOpenFailure(context.databasePath);
    },
  };
}
