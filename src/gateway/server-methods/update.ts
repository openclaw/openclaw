import type { GatewayRequestHandlers } from "./types.js";
import { updateRecoveryCleanupHandler } from "./update-cleanup.js";
import { updateReportHandler } from "./update-report.js";
import { updateRunHandler } from "./update-run.js";
import { updateStatusHandlers } from "./update-status.js";

export const updateHandlers: GatewayRequestHandlers = {
  ...updateStatusHandlers,
  "update.report": updateReportHandler,
  "update.recovery.cleanup": updateRecoveryCleanupHandler,
  "update.run": updateRunHandler,
};
