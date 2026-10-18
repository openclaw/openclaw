/** Publicly stable limits for private per-job scratch content. */
export const CRON_JOB_SCRATCH_MAX_BYTES = 256 * 1024;

type CronJobScratch = {
  content: string;
  revision: number;
  sourceSha256?: string;
  updatedAtMs: number;
};

/** An unset retains its revision tombstone so stale writers cannot resurrect content. */
export type CronJobScratchState = {
  currentRevision: number;
  scratch?: CronJobScratch;
};

export type CronScratchReadCommand = {
  type: "cron.scratch";
  storeKey: string;
  selector:
    | { kind: "job"; jobId: string; createdAtMsFallback: number }
    | { kind: "heartbeat"; agentId: string };
};

export type CronScratchSnapshot = {
  jobId: string;
  state: CronJobScratchState;
  configRevision?: string;
};

export type CronJobScratchWriteResult =
  | { ok: true; currentRevision: number; scratch?: CronJobScratch }
  | { ok: false; reason: "revision-conflict"; currentRevision: number };

export type CronJobScratchWriteInput = {
  storeKey: string;
  jobId: string;
  content: string | null;
  expectedRevision?: number;
  sourceSha256?: string;
  nowMs: number;
};

export type CronJobScratchWriteOutcome = {
  result: CronJobScratchWriteResult;
  written: boolean;
};

export function assertCronJobScratchContent(content: string): void {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > CRON_JOB_SCRATCH_MAX_BYTES) {
    throw new Error(
      `cron scratch exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes (${sizeBytes} bytes provided)`,
    );
  }
}
