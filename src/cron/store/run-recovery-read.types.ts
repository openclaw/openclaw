import type { CronJob } from "../types.js";
import type { CronRunReceiptRecoveryCandidate } from "./run-receipt.types.js";

export type CronRunRecoveryProposal = {
  jobId: string;
  queuedAtMs?: number;
  runningAtMs?: number;
  runningReceiptId?: string;
  receipt?: CronRunReceiptRecoveryCandidate;
};

export type CronRunRecoveryObservation =
  | {
      kind: "observed";
      proposals: Array<
        CronRunRecoveryProposal & { routing?: Pick<CronJob, "id" | "delivery" | "failureAlert"> }
      >;
    }
  | { kind: "schema-uninitialized" };

export type CronRunRecoveryReadCommand = {
  type: "cron.observeRunRecovery";
  storeKey: string;
  proposals: readonly CronRunRecoveryProposal[];
};
