import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createCronMaintenanceScheduler } from "./maintenance-scheduler.js";
import { runSessionRegistryMaintenance } from "./session-registry-maintenance.js";
import { maintainCronRunHistory } from "./store/run-history.js";

const log = createSubsystemLogger("cron/maintenance");

/** Gateway lifecycle owns retention even when scheduled execution is disabled. */
export const { start: startCronMaintenance, stop: stopCronMaintenance } =
  createCronMaintenanceScheduler(
    async (signal) => {
      const context = captureOpenClawStateWorkerContext();
      const assertCurrent = () => {
        context.admission.assertCurrent();
      };
      // Scheduler shutdown stops pruning between batches; the next sweep resumes it.
      await maintainCronRunHistory(context, assertCurrent, { signal });
      assertCurrent();
      const result = await runSessionRegistryMaintenance({ apply: true, assertCurrent });
      assertCurrent();
      if (result.skippedReason) {
        log.warn("Session registry maintenance skipped", { reason: result.skippedReason });
      }
    },
    (error) => log.warn("Cron maintenance failed", { error }),
  );
