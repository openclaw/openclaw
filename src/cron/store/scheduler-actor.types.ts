import type { CronConfig } from "../../config/types.cron.js";
import type { CronNotificationIntent } from "../service/notification-intents.js";
import type { CronJob } from "../types.js";
import type { CronRunQueueOperations, CronRunRequestContext } from "./run-queue.types.js";
import type { CronRunRecoveryOutcome } from "./run-recovery.types.js";

export type CronScheduleMaintenanceOptions = {
  recomputeExpired?: boolean;
  nowMs?: number;
  repairFutureCronNextRunAtMs?: boolean;
  preserveExpiredPacedNextRunJobId?: string;
  skipScheduleErrorHandling?: boolean;
};

export type CronSchedulerConfig = {
  cronEnabled: boolean;
  cronConfig?: CronConfig;
  defaultAgentId?: string;
  configuredChannels?: string[];
  maxMissedJobsPerRestart?: number;
  missedJobStaggerMs?: number;
  startupDeferredMissedAgentJobDelayMs?: number;
};

/** Versions order pushed config only; they never authorize a run. */
export type CronSchedulerSnapshot = { version: number; config: CronSchedulerConfig };

export type CronSchedulerResult = CronRunQueueOperations["cron.requestRuns"]["output"] &
  CronRunQueueOperations["cron.drainQueue"]["output"] & {
    jobs: CronJob[];
    ownerless: CronJob[];
    notifications: CronNotificationIntent[];
    logs: CronRunRecoveryOutcome["logs"];
    nextWakeAtMs?: number;
  };

type CronSchedulerCommand = {
  storeKey: string;
  channelName?: string;
  paused?: boolean;
  nowMs?: number;
  monotonicMs?: number;
  requests?: CronRunRequestContext[];
  snapshot?: CronSchedulerSnapshot;
};

export type CronSchedulerOperations = {
  "cron.schedulerStart": {
    input: CronSchedulerCommand & {
      channelName: string;
      snapshot: CronSchedulerSnapshot;
      skipJobIds?: string[];
      deferAgentWork?: boolean;
    };
    output: CronSchedulerResult;
  };
  "cron.schedulerTick": { input: CronSchedulerCommand; output: CronSchedulerResult };
  "cron.schedulerRefresh": {
    input: CronSchedulerCommand & {
      options?: CronScheduleMaintenanceOptions;
    };
    output: CronSchedulerResult;
  };
  "cron.schedulerStop": {
    input: { storeKey: string; channelName: string };
    output: void;
  };
};

export type CronSchedulerWake = { type: "cron.schedulerWake"; storeKey: string };
