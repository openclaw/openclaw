import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getFleetCellInDatabase, listFleetCellsInDatabase } from "../fleet/registry.kernel.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { serveWorkerTasks } from "../infra/worker-task-pool.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-readonly.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

function isReadRequest(input: unknown): input is OpenClawStateReadRequest {
  if (!isRecord(input) || !isRecord(input.context) || !isRecord(input.command)) {
    return false;
  }
  const { environment, coordinatorRuntime } = input.context;
  return (
    typeof input.databasePath === "string" &&
    typeof input.location === "string" &&
    typeof input.checkFreshAdmission === "boolean" &&
    isRecord(environment) &&
    typeof environment.OPENCLAW_STATE_DIR === "string" &&
    (environment.OPENCLAW_SUPERVISOR_MODE === undefined ||
      environment.OPENCLAW_SUPERVISOR_MODE === "external") &&
    isRecord(coordinatorRuntime) &&
    typeof coordinatorRuntime.directory === "string" &&
    typeof coordinatorRuntime.keepAlive === "boolean" &&
    (input.command.type === "admit" ||
      input.command.type === "fleet.list" ||
      (input.command.type === "fleet.get" && typeof input.command.tenantId === "string"))
  );
}

serveWorkerTasks((input): OpenClawStateReadReply => {
  let sourceAdmitted: true | undefined;
  try {
    if (!isReadRequest(input)) {
      throw new Error("Fleet registry reader requires a captured state location and read command");
    }
    return withStateDatabaseCoordinatorRuntimeDirectory(input.context.coordinatorRuntime, () => {
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
          return command.type === "fleet.list"
            ? { ok: true, type: "fleet.list", sourceAdmitted, cells: listFleetCellsInDatabase(db) }
            : {
                ok: true,
                type: "fleet.get",
                sourceAdmitted,
                cell: getFleetCellInDatabase(db, command.tenantId),
              };
        },
        input.databasePath,
        input.location,
      );
    });
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
