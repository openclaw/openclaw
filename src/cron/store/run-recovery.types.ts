import type { CronConfig } from "../../config/types.cron.js";
import type { CronNotificationIntent } from "../service/notification-intents.js";
import type { CronJob } from "../types.js";

export type CronRunRecoveryInput = {
  storeKey: string;
  nowMs: number;
  cronConfig?: CronConfig;
};

export type CronRunRecoveryOutcome = {
  jobs: CronJob[];
  removedJobIds: string[];
  interruptedRuns: InterruptedStartupRun[];
  notifications: CronNotificationIntent[];
  skipJobIds: string[];
  logs: Array<{ level: "debug" | "info" | "warn" | "error"; fields: unknown; message?: string }>;
};

export type InterruptedStartupRun = {
  jobId: string;
  runId?: string;
  runAtMs: number;
  durationMs: number;
  replacementAtMs?: number;
};
