import {
  type BackupStatusResult,
  validateBackupStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { summarizeBackupSchedules } from "../../cron/backup-command.js";
import { getLoadedRuntimePluginRegistry } from "../../plugins/active-runtime-registry.js";
import { readBackupRuns, summarizeBackupTargets } from "../../state/backup-run-records.js";
import { listStorageLocations } from "../../storage/locations.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const backupHandlers: GatewayRequestHandlers = {
  "backup.status": defineValidatedGatewayMethod(
    "backup.status",
    validateBackupStatusParams,
    async ({ context, respond }) => {
      const [runs, jobs] = await Promise.all([
        readBackupRuns(process.env),
        context.cron.list({ includeDisabled: true }),
      ]);
      const result: BackupStatusResult = {
        targets: summarizeBackupTargets(runs),
        schedules: summarizeBackupSchedules(jobs),
        locations: listStorageLocations(
          context.getRuntimeConfig(),
          getLoadedRuntimePluginRegistry() ?? undefined,
        ),
      };
      respond(true, result, undefined);
    },
  ),
};
