import type { CronRunReceiptRecoveryCandidate } from "./run-receipt.types.js";

export type CronRunRecoveryProposal = {
  jobId: string;
  queuedAtMs?: number;
  runningAtMs?: number;
  runningReceiptId?: string;
  receipt?: CronRunReceiptRecoveryCandidate;
};

export type CronRunRecoveryObservation =
  | { kind: "observed"; proposals: CronRunRecoveryProposal[] }
  | { kind: "schema-uninitialized" };

export type CronRunRecoveryReadCommand = {
  type: "cron.observeRunRecovery";
  storeKey: string;
  proposals: readonly CronRunRecoveryProposal[];
};
