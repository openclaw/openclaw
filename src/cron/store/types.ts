import type { CronStoreFile } from "../types.js";

export type QuarantinedCronConfigJob = {
  sourceIndex: number;
  reason: string;
  job?: Record<string, unknown>;
  raw?: unknown;
  state?: Record<string, unknown>;
  updatedAtMs?: number;
  scheduleIdentity?: string;
};

export type CronQuarantineFile = {
  version: 1;
  jobs: Array<QuarantinedCronConfigJob & { quarantinedAtMs: number }>;
};

export type CronConfigJobRuntimeEntry = {
  updatedAtMs?: number;
  scheduleIdentity?: string;
  state?: Record<string, unknown>;
};

export type LoadedCronStore = {
  store: CronStoreFile;
  configJobs: Array<Record<string, unknown>>;
  configJobIndexes: number[];
  configJobRuntimeEntries: CronConfigJobRuntimeEntry[];
  invalidConfigRows: QuarantinedCronConfigJob[];
};
