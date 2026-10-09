import { randomUUID } from "node:crypto";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import type { CronJob, CronPayload, CronSchedule } from "./types.js";

// Default, minimum, and maximum are shared by normalization and runtime reads.
const CRON_STREAM_BATCHING_BOUNDS = {
  batchMs: [250, 50, 5_000],
  maxBatchBytes: [16_384, 1_024, 65_536],
} as const;
const CRON_STREAM_TRUNCATED_MARKER = "[truncated]";

export type CronStreamSchedule = Extract<CronSchedule, { kind: "stream" }>;

/** A committed identity is a result fact; later writes still require the normal source checks. */
export class CronStreamSourceRetirementError extends Error {
  constructor(
    readonly retirement: {
      jobId: string;
      scheduleKey: string;
      previousIdentity: string;
      identity: string;
    },
    cause: unknown,
  ) {
    super("Cron stream source retirement committed before the operation failed", { cause });
    this.name = "CronStreamSourceRetirementError";
  }
}

/** Opaque identity for one logical stream source across child-process restarts. */
export function createCronStreamSourceIdentity(): string {
  return randomUUID();
}

function clampInteger(
  value: unknown,
  [fallback, min, max]: readonly [number, number, number],
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("stream schedule batching values must be integers");
  }
  return Math.max(min, Math.min(max, value));
}

/** Resolve stream batching defaults without rewriting omitted public fields. */
export function resolveCronStreamBatching(schedule: CronStreamSchedule): {
  batchMs: number;
  maxBatchBytes: number;
} {
  return {
    batchMs: clampInteger(schedule.batchMs, CRON_STREAM_BATCHING_BOUNDS.batchMs),
    maxBatchBytes: clampInteger(schedule.maxBatchBytes, CRON_STREAM_BATCHING_BOUNDS.maxBatchBytes),
  };
}

/** Stable key for the source definition, with omitted defaults resolved. */
export function cronStreamScheduleKey(schedule: CronStreamSchedule): string {
  const batching = resolveCronStreamBatching(schedule);
  return JSON.stringify({
    command: schedule.command,
    cwd: schedule.cwd,
    mode: schedule.mode ?? "line",
    match: schedule.match,
    batchMs: batching.batchMs,
    maxBatchBytes: batching.maxBatchBytes,
  });
}

/** Clamp explicitly supplied stream batching fields during create/update normalization. */
export function normalizeCronStreamBatching(schedule: Record<string, unknown>): void {
  for (const field of ["batchMs", "maxBatchBytes"] as const) {
    const value = schedule[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(`stream schedule ${field} must be an integer`);
    }
    schedule[field] = clampInteger(value, CRON_STREAM_BATCHING_BOUNDS[field]);
  }
}

/** Render known-truncated source text without exposing the marker to match filters. */
export function markCronStreamBatchTruncated(text: string, maxBytes: number): string {
  const markerBytes = Buffer.byteLength(CRON_STREAM_TRUNCATED_MARKER, "utf8");
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  return `${truncateUtf8Prefix(text, contentBudget)}${CRON_STREAM_TRUNCATED_MARKER}`;
}

/** Keep a UTF-8 batch inside its byte budget and reserve room for the marker. */
export function truncateCronStreamBatch(text: string, maxBytes: number): string {
  return Buffer.byteLength(text, "utf8") <= maxBytes
    ? text
    : markCronStreamBatchTruncated(text, maxBytes);
}

/** Append event text through the same payload seam used by trigger messages. */
export function appendCronPayloadText(payload: CronPayload, text: string): CronPayload {
  if (payload.kind === "systemEvent") {
    return { ...payload, text: `${payload.text}\n\n${text}` };
  }
  if (payload.kind === "agentTurn") {
    return { ...payload, message: `${payload.message}\n\n${text}` };
  }
  return payload;
}

/** Returns whether a stream event still belongs to the job's current logical source. */
export function ownsStreamSource(
  job: CronJob,
  streamScheduleKey: string,
  streamSourceIdentity: string,
): boolean {
  return (
    job.schedule.kind === "stream" &&
    cronStreamScheduleKey(job.schedule) === streamScheduleKey &&
    job.state.streamSourceIdentity === streamSourceIdentity
  );
}
