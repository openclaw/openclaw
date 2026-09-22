import type { DeferredCronNotifications } from "../service/state.js";
import type { CronJob } from "../types.js";
import type { CronRunRecoveryOutcome, CronRunRecoveryPreparation } from "./run-recovery.types.js";
import type { CronRuntimeMutationInputs } from "./runtime-worker.types.js";

type CronScheduleOwnershipFacts = {
  jobId: string;
  active: boolean;
  reservation?: { markerAtMs: number; preserveWhenDisabled: boolean };
};

export type CronRuntimeMutationContracts = {
  "cron.repairRun": {
    input: CronRuntimeMutationInputs["cron.repairRun"];
    facts: Pick<CronJob, "id" | "delivery" | "failureAlert">;
    preparation: CronRunRecoveryPreparation;
    outcome: CronRunRecoveryOutcome;
  };
  "cron.scheduleUnowned": {
    input: CronRuntimeMutationInputs["cron.scheduleUnowned"];
    facts: { jobIds: string[] };
    preparation: { nowMs: number; ownership: CronScheduleOwnershipFacts[] };
    outcome: {
      changed: boolean;
      jobs: CronJob[];
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.recordFailureAlertOutcome": {
    input: CronRuntimeMutationInputs["cron.recordFailureAlertOutcome"];
    facts: { ownsCycle: boolean };
    preparation: Record<string, never>;
    outcome: { job?: CronJob };
  };
};
