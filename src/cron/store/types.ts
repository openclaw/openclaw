import type { QuarantinedCronConfigJob } from "../types-shared.js";
/** Shared cron SQLite store and quarantine types. */
import type { CronStoreFile } from "../types.js";

/** Runtime state retained for config-sourced jobs that are not persisted as canonical jobs. */
export type CronConfigJobRuntimeEntry = {
  updatedAtMs?: number;
  scheduleIdentity?: string;
  state?: Record<string, unknown>;
};

/** Combined cron store load result with canonical jobs and config-backed metadata. */
export type LoadedCronStore = {
  store: CronStoreFile;
  configJobs: Array<Record<string, unknown>>;
  configJobIndexes: number[];
  configJobRuntimeEntries: CronConfigJobRuntimeEntry[];
  invalidConfigRows: QuarantinedCronConfigJob[];
  jobsFingerprint?: string;
  runtimeFingerprint?: string;
};
