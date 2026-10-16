import {
  type BackupStatusResult,
  validateBackupRecordOutcomeParams,
  validateBackupStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { summarizeBackupSchedules } from "../../cron/backup-command.js";
import { getLoadedRuntimePluginRegistry } from "../../plugins/active-runtime-registry.js";
import {
  readBackupRuns,
  recordBackupRunOutcome,
  summarizeBackupTargets,
} from "../../state/backup-run-records.js";
import { listStorageLocations } from "../../storage/locations.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const backupHandlers: GatewayRequestHandlers = {
  "backup.recordOutcome": defineValidatedGatewayMethod(
    "backup.recordOutcome",
    validateBackupRecordOutcomeParams,
    async (opts) => {
      let assertCurrent: () => void;
      try {
        assertCurrent = captureLocalStateMutationGuard(opts.params.expectedOwnerId, opts);
      } catch (error) {
        opts.respond(false, undefined, localStateOwnerChangedError(error));
        return;
      }
      await respondUnavailableOnThrow(opts.respond, async () => {
        await recordBackupRunOutcome(opts.params.outcome, { assertCurrent, signal: opts.signal });
        opts.respond(true, { recorded: true }, undefined);
      });
    },
  ),
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
