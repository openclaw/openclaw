import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createCronMaintenanceScheduler } from "./maintenance-scheduler.js";
import { runSessionRegistryMaintenance } from "./session-registry-maintenance.js";
import { maintainCronRunHistory } from "./store/run-history.js";

const log = createSubsystemLogger("cron/maintenance");

/** Gateway lifecycle owns retention even when scheduled execution is disabled. */
export const { start: startCronMaintenance, stop: stopCronMaintenance } =
  createCronMaintenanceScheduler(
    async () => {
      const context = captureOpenClawStateWorkerContext();
      const assertCurrent = () => {
        context.admission.assertCurrent();
      };
      await maintainCronRunHistory(context, assertCurrent);
      assertCurrent();
      const result = await runSessionRegistryMaintenance({ apply: true, assertCurrent });
      assertCurrent();
      if (result.skippedReason) {
        log.warn("Session registry maintenance skipped", { reason: result.skippedReason });
      }
    },
    (error) => log.warn("Cron maintenance failed", { error }),
  );
