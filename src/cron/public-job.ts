import type { CronJob } from "./types.js";

const CRON_ENV_REDACTED = "[redacted]" as const;

type JsonReadback<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly JsonReadback<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: JsonReadback<T[Key]> }
      : T;

/**
 * Output-only cron representation. Deep readonly arrays intentionally make this
 * structurally incompatible with CronJobCreate/CronJobPatch mutation inputs.
 */
type CronJobReadback = JsonReadback<CronJob>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Clone JSON readback values and redact every command-payload env value.
 *
 * The recursive shape covers jobs nested in list/get envelopes and alternative
 * serializers without mutating the stored/runtime CronJob.
 */
export function redactCronJsonReadback<T>(value: T): JsonReadback<T> {
  if (Array.isArray(value)) {
    return value.map((item) => redactCronJsonReadback(item)) as JsonReadback<T>;
  }
  if (!isRecord(value)) {
    return value as JsonReadback<T>;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "env" && value.kind === "command" && isRecord(child)) {
      redacted[key] = Object.fromEntries(
        Object.keys(child).map((envKey) => [envKey, CRON_ENV_REDACTED]),
      );
      continue;
    }
    redacted[key] = redactCronJsonReadback(child);
  }
  return redacted as JsonReadback<T>;
}

/** Remove scheduler-only state before a cron job crosses a public API boundary. */
export function toPublicCronJob(job: CronJob): CronJobReadback {
  const state = { ...job.state };
  delete state.queuedAtMs;
  delete state.startupCatchupAtMs;
  delete state.pacedNextRunAtMs;
  delete state.forcePreservedNextRunAtMs;
  return redactCronJsonReadback({ ...job, state });
}
