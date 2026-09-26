import type { DeferredCronNotifications } from "../service/state.js";
import type { CronJob } from "../types.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";
import type { CronRunRecoveryOutcome, CronRunRecoveryPreparation } from "./run-recovery.types.js";
import type { CronRuntimeMutationInputs } from "./runtime-worker.types.js";

type CronScheduleOwnershipFacts = {
  jobId: string;
  active: boolean;
  reservation?: { markerAtMs: number; preserveWhenDisabled: boolean };
};

export type CronRuntimeMutationContracts = {
  "cron.activateRun": {
    input: CronRuntimeMutationInputs["cron.activateRun"];
    facts: Record<string, never>;
    preparation: { markerAtMs: number; defaultAgentId?: string };
    outcome: {
      activation?: { job: CronJob; receipt: CronRunReceiptHandle; previousLastError?: string };
    };
  };
  "cron.releaseReservations": {
    input: CronRuntimeMutationInputs["cron.releaseReservations"];
    facts: { deletionBlocked: boolean };
    preparation: {
      nowMs: number;
      defaultAgentId?: string;
      reservations: Array<{
        jobId: string;
        markerAtMs: number;
        runReceipt: CronRunReceiptHandle;
        activationPreviousLastError?: { value: string | undefined };
      }>;
      deferTerminal: boolean;
    };
    outcome: {
      jobs: CronJob[];
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.finishReceipt": {
    input: CronRuntimeMutationInputs["cron.finishReceipt"];
    facts: Record<string, never>;
    preparation: Record<string, never>;
    outcome: Record<string, never>;
  };
  "cron.removeStaleFamily": {
    input: CronRuntimeMutationInputs["cron.removeStaleFamily"];
    facts: Record<string, never>;
    preparation: Record<string, never>;
    outcome: { removed: number };
  };
  "cron.repairRuns": {
    input: CronRuntimeMutationInputs["cron.repairRuns"];
    facts: Array<Pick<CronJob, "id" | "delivery" | "failureAlert">>;
    preparation: CronRunRecoveryPreparation[];
    outcome: { outcomes: CronRunRecoveryOutcome[] };
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
