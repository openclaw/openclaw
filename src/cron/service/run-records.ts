import { randomBytes } from "node:crypto";
import type {
  CronDeliveryStatus,
  CronRunRecord,
  CronRunStatus,
  CronRunTrigger,
  CronStoreFile,
} from "../types.js";

const DEFAULT_MAX_CRON_RUN_RECORDS = 500;

function ensureRuns(store: CronStoreFile): CronRunRecord[] {
  store.runs ??= [];
  return store.runs;
}

function pruneRunRecords(store: CronStoreFile, maxRecords = DEFAULT_MAX_CRON_RUN_RECORDS): void {
  const runs = ensureRuns(store);
  if (runs.length <= maxRecords) {
    return;
  }
  store.runs = runs.slice(runs.length - maxRecords);
}

export function createCronRunId(jobId: string, startedAtMs: number): string {
  return `cron:${jobId}:${startedAtMs}:${randomBytes(4).toString("hex")}`;
}

export function appendRunningCronRunRecord(params: {
  store: CronStoreFile;
  jobId: string;
  trigger: CronRunTrigger;
  scheduledAtMs?: number;
  startedAtMs: number;
}): CronRunRecord {
  const record: CronRunRecord = {
    runId: createCronRunId(params.jobId, params.startedAtMs),
    jobId: params.jobId,
    trigger: params.trigger,
    scheduledAtMs: params.scheduledAtMs,
    startedAtMs: params.startedAtMs,
    status: "running",
  };
  ensureRuns(params.store).push(record);
  pruneRunRecords(params.store);
  return record;
}

export function finalizeCronRunRecord(params: {
  store: CronStoreFile;
  runId: string;
  status: CronRunStatus;
  endedAtMs: number;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  model?: string;
  provider?: string;
  usage?: CronRunRecord["usage"];
}): CronRunRecord | undefined {
  const record = ensureRuns(params.store).find((entry) => entry.runId === params.runId);
  if (!record) {
    return undefined;
  }
  record.status = params.status;
  record.endedAtMs = params.endedAtMs;
  record.error = params.error;
  record.summary = params.summary;
  record.delivered = params.delivered;
  record.deliveryStatus = params.deliveryStatus;
  record.deliveryError = params.deliveryError;
  record.sessionId = params.sessionId;
  record.sessionKey = params.sessionKey;
  record.model = params.model;
  record.provider = params.provider;
  record.usage = params.usage;
  return record;
}

export function failRunningCronRunsForJob(params: {
  store: CronStoreFile;
  jobId: string;
  endedAtMs: number;
  error: string;
}): boolean {
  let changed = false;
  for (const run of ensureRuns(params.store)) {
    if (run.jobId !== params.jobId || run.status !== "running") {
      continue;
    }
    run.status = "error";
    run.endedAtMs = params.endedAtMs;
    run.error = params.error;
    run.deliveryStatus ??= "unknown";
    changed = true;
  }
  return changed;
}
