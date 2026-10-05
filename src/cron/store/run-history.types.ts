export type CronJsonValue =
  | null
  | boolean
  | number
  | string
  | CronJsonValue[]
  | { [key: string]: CronJsonValue };

/** Only cron's persisted history/recovery facts, not a generic execution registry. */
export type CronRunRecord = {
  id: string;
  jobId: string | null;
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  status: string;
  error?: string;
  summary?: string;
  detail?: CronJsonValue;
};

/**
 * One over-cap job ranked earlier in a maintenance sweep: the oldest retained row of each
 * full retention partition, and how far the oldest-first overflow scan has read.
 */
export type CronRunOverflowCursor = {
  jobId: string;
  boundaries: Array<{ partition: string; row: CronRunRecord }>;
  scan?:
    | { dated: false; after?: { createdAt: number; id: string } }
    | { dated: true; after?: { endedAt: number; createdAt: number; id: string } };
};

export type CronRunHistoryWrite = {
  storeKey: string;
  jobId: string;
  runId: string;
  agentId?: string;
  startedAt: number;
  endedAt: number;
  sessionKey?: string;
  status: string;
  error?: string;
  summary?: string;
  detail: CronJsonValue;
};

export type CronRunHistoryWorkerOperations = {
  "cron.recordRun": { input: CronRunHistoryWrite; output: void };
};
