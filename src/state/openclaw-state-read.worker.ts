import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ExecutionDecisionCursorError } from "../audit/execution-decision-receipts.js";
import { inspectExecutionIdentityRunInDatabase } from "../audit/execution-identity-context.js";
import { getFleetCellInDatabase, listFleetCellsInDatabase } from "../fleet/registry.kernel.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { serveWorkerTasks } from "../infra/worker-task-pool.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";
import { selectProfileDisplayEntries } from "./user-profiles-internal.js";

function isReadRequest(input: unknown): input is OpenClawStateReadRequest {
  if (!isRecord(input) || !isRecord(input.context) || !isRecord(input.command)) {
    return false;
  }
  const { environment, coordinatorRuntime } = input.context;
  return (
    typeof input.databasePath === "string" &&
    typeof input.location === "string" &&
    typeof input.checkFreshAdmission === "boolean" &&
    (input.expectedIdentity === undefined || typeof input.expectedIdentity === "string") &&
    (input.snapshotRoot === undefined || typeof input.snapshotRoot === "string") &&
    (input.context.existingSchemaPath === undefined ||
      typeof input.context.existingSchemaPath === "string") &&
    isRecord(environment) &&
    typeof environment.OPENCLAW_STATE_DIR === "string" &&
    (environment.OPENCLAW_SUPERVISOR_MODE === undefined ||
      environment.OPENCLAW_SUPERVISOR_MODE === "external") &&
    isRecord(coordinatorRuntime) &&
    typeof coordinatorRuntime.directory === "string" &&
    typeof coordinatorRuntime.keepAlive === "boolean" &&
    (input.command.type === "admit" ||
      (input.command.type === "userProfiles.reconcile" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "audit.run.inspect" &&
        isRecord(input.command.input) &&
        typeof input.command.input.now === "number" &&
        (typeof input.command.input.runId === "string" ||
          typeof input.command.input.executionId === "string")) ||
      input.command.type === "fleet.list" ||
      input.command.type === "nodeHost.config" ||
      (input.command.type === "fleet.get" && typeof input.command.tenantId === "string"))
  );
}

serveWorkerTasks((input): OpenClawStateReadReply => {
  let sourceAdmitted: true | undefined;
  try {
    if (!isReadRequest(input)) {
      throw new Error("Shared-state reader requires a captured state location and read command");
    }
    return runWithSqliteWorkerStateContext(input.context, () =>
      withStateDatabaseCoordinatorRuntimeDirectory(input.context.coordinatorRuntime, () => {
        if (input.checkFreshAdmission) {
          openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
            input.databasePath,
            input.context.environment,
          );
        }
        const { command } = input;
        if (command.type === "admit") {
          return { ok: true, type: "admit" };
        }
        return withOpenClawStateReadOnlyLocation(
          ({ db }) => {
            sourceAdmitted = true;
            if (command.type === "audit.run.inspect") {
              try {
                return {
                  ok: true,
                  type: command.type,
                  sourceAdmitted,
                  result: {
                    status: "inspected",
                    inspection: inspectExecutionIdentityRunInDatabase(db, command.input),
                  },
                };
              } catch (error) {
                if (!(error instanceof ExecutionDecisionCursorError)) {
                  throw error;
                }
                return {
                  ok: true,
                  type: command.type,
                  sourceAdmitted,
                  result: { status: "invalid-cursor", message: error.message },
                };
              }
            }
            if (command.type === "nodeHost.config") {
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                row: readConfigMachineStateRowInDatabase(db, command.type),
              };
            }
            if (command.type === "userProfiles.reconcile") {
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                profile: runSqliteDeferredTransactionSync(
                  db,
                  () => selectProfileDisplayEntries(db, [command.profileId])[0]?.[1],
                ),
              };
            }
            return command.type === "fleet.list"
              ? {
                  ok: true,
                  type: "fleet.list",
                  sourceAdmitted,
                  cells: listFleetCellsInDatabase(db),
                }
              : {
                  ok: true,
                  type: "fleet.get",
                  sourceAdmitted,
                  cell: getFleetCellInDatabase(db, command.tenantId),
                };
          },
          input.databasePath,
          input.location,
          undefined,
          input.expectedIdentity,
          input.snapshotRoot,
        );
      }),
    );
  } catch (value) {
    const error = toStringifiedError(value);
    return {
      ok: false,
      sourceAdmitted,
      message: error.message,
      error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
    };
  }
});
