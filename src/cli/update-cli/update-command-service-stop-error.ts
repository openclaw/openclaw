import { ServiceInspectionError } from "../../daemon/service-inspection-error.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  StateDatabaseAdmissionPendingError,
  StateDatabaseOfflineMaintenanceError,
} from "../../infra/gateway-state-owner-errors.js";
import { createUpdateFailureFact } from "../../infra/update-failure-facts.js";
import { UpdatePreMutationError } from "../../infra/update-pre-mutation-error.js";

/** Preserve the rejecting owner before aggregation and public diagnostic projection. */
export function createManagedServiceStopError(error: unknown, env?: NodeJS.ProcessEnv) {
  const cause =
    collectNestedErrorCandidates(error).findLast(
      (candidate) =>
        candidate instanceof ServiceInspectionError ||
        candidate instanceof StateDatabaseAdmissionPendingError ||
        candidate instanceof StateDatabaseOfflineMaintenanceError,
    ) ?? error;
  const reason = cause instanceof ServiceInspectionError ? cause.reason : undefined;
  const message = formatErrorMessage(cause);
  // The path belongs to this typed refusal. Remove it before generic path
  // redaction can consume the holder diagnostics that follow it.
  const detail =
    cause instanceof StateDatabaseAdmissionPendingError ||
    cause instanceof StateDatabaseOfflineMaintenanceError
      ? message.replaceAll(cause.databasePath, "<shared state>")
      : message;
  return new UpdatePreMutationError(
    reason ?? "managed-service-stop-failed",
    `Failed to stop managed gateway service before update: ${formatErrorMessage(error)}`,
    {
      cause: error,
      failureFacts: [
        createUpdateFailureFact(
          {
            check: "managed-service",
            code: reason ?? "managed-service-stop-failed",
            message: detail,
          },
          env,
        ),
      ],
    },
  );
}
