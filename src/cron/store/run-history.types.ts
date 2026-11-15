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
