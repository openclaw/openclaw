import type { CronConfig } from "../../config/types.cron.js";
import type {
  CronNotificationIntent,
  ResolvedFailureAlert,
} from "../service/notification-intents.js";
import type { CronRunReceiptRecoveryCandidate } from "./run-receipt.types.js";

export type CronRunRecoveryResult =
  | { kind: "live"; receipt: CronRunReceiptRecoveryCandidate }
  | { kind: "superseded"; receipt?: CronRunReceiptRecoveryCandidate }
  | {
      kind: "repaired";
      interrupted?: InterruptedStartupRun;
      notifications: CronNotificationIntent[];
      skipStartupCatchup?: boolean;
    };

export type CronRunRecoveryOutcome = {
  result: CronRunRecoveryResult;
  logs: Array<{ level: "debug" | "info" | "warn" | "error"; fields: unknown; message?: string }>;
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
