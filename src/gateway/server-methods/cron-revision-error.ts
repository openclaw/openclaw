import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { CronJobConfigRevisionConflictError } from "../../cron/config-revision.js";
import type { RespondFn } from "./types.js";

export function respondCronJobConfigRevisionConflict(
  respond: RespondFn,
  error: CronJobConfigRevisionConflictError,
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      "cron job definition no longer matches the loaded version; review the latest version before retrying",
      {
        details: {
          code: "CRON_JOB_CHANGED",
          expectedConfigRevision: error.expectedConfigRevision,
          actualConfigRevision: error.actualConfigRevision,
        },
      },
    ),
  );
}
