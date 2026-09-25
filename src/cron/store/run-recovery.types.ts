import type { CronConfig } from "../../config/types.cron.js";
import type { ResolvedFailureAlert } from "../service/notification-intents.js";
import type { DeferredCronNotifications, Logger } from "../service/state.js";
import type { CronRunReceiptRecoveryCandidate } from "./run-receipt.types.js";

export type CronRunRecoveryResult =
  | { kind: "live"; receipt: CronRunReceiptRecoveryCandidate }
  | { kind: "superseded"; receipt?: CronRunReceiptRecoveryCandidate }
  | {
      kind: "repaired";
      interrupted?: InterruptedStartupRun;
      notifications: DeferredCronNotifications;
      skipStartupCatchup?: boolean;
    };

export type CronRunRecoveryOutcome = {
  result: CronRunRecoveryResult;
  logs: Array<{ level: keyof Logger; fields: unknown; message?: string }>;
};

export type CronRunRecoveryPreparation = {
  proposedReceiptIsStale: boolean;
  nowMs: number;
  cronConfig?: CronConfig;
  failureAlert: ResolvedFailureAlert | null;
};

export type InterruptedStartupRun = {
  jobId: string;
  taskRunId?: string;
  runAtMs: number;
  durationMs: number;
  replacementAtMs?: number;
};
