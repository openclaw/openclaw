/** Builds stable identities for cron scheduling inputs. */
import { stableStringify } from "@openclaw/normalization-core";
import {
  asSafeIntegerInRange,
  parseStrictFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import { parseCronPacingBounds } from "./pacing.js";
import { coerceFiniteScheduleNumber } from "./schedule-number.js";
import { isCronEventSchedule } from "./source-schedule.js";
import { normalizeCronStaggerMs } from "./stagger.js";
import type { CronSchedule } from "./types.js";

type CronScheduleIdentityInput = { schedule?: unknown; enabled?: unknown } & Record<
  string,
  unknown
>;

function readScheduleInteger(record: Record<string, unknown>, key: string): number | undefined {
  const parsed = parseStrictFiniteNumber(record[key]);
  return asSafeIntegerInRange(parsed, {
    min: Number.MIN_SAFE_INTEGER,
    max: Number.MAX_SAFE_INTEGER,
  });
}

function schedulePayloadFromRecord(schedule: Record<string, unknown>): CronSchedule | undefined {
  const rawKind = normalizeOptionalString(schedule.kind)?.toLowerCase();
  const expr = normalizeOptionalString(schedule.expr);
  const at = normalizeOptionalString(schedule.at);
  const everyMs = coerceFiniteScheduleNumber(schedule.everyMs);
  const anchorMs = coerceFiniteScheduleNumber(schedule.anchorMs);
  const tz = normalizeOptionalString(schedule.tz);
  const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
  const kind =
    // Infer legacy shorthand schedule shapes when kind is missing so timer
    // identity remains stable across old persisted jobs and normalized jobs.
    rawKind === "at" ||
    rawKind === "every" ||
    rawKind === "cron" ||
    rawKind === "on-exit" ||
    rawKind === "stream" ||
    rawKind === "event"
      ? rawKind
      : at
        ? "at"
        : everyMs !== undefined
          ? "every"
          : expr
            ? "cron"
            : undefined;

  if (kind === "event") {
    return isCronEventSchedule(schedule) ? schedule : undefined;
  }
  if (kind === "at") {
    return at ? { kind: "at", at } : undefined;
  }
  if (kind === "every" && everyMs !== undefined) {
    return { kind: "every", everyMs, anchorMs };
  }
  if (kind === "cron" && expr) {
    return { kind: "cron", expr, tz, staggerMs };
  }
  if (kind === "on-exit") {
    const command = readNonBlankString(schedule.command);
    return command
      ? { kind: "on-exit", command, cwd: normalizeOptionalString(schedule.cwd) }
      : undefined;
  }
  if (kind === "stream") {
    const command = schedule.command;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
      return undefined;
    }
    const mode = normalizeOptionalString(schedule.mode);
    return {
      kind: "stream",
      command: [...command],
      cwd: normalizeOptionalString(schedule.cwd),
      mode: mode === "line" || mode === "match" ? mode : undefined,
      match: typeof schedule.match === "string" ? schedule.match : undefined,
      batchMs: readScheduleInteger(schedule, "batchMs"),
      maxBatchBytes: readScheduleInteger(schedule, "maxBatchBytes"),
    };
  }
  return undefined;
}

function resolvePacingPayload(
  job: CronScheduleIdentityInput,
): { minMs?: number; maxMs?: number } | null | undefined {
  if (job.pacing === undefined || job.pacing === null) {
    return undefined;
  }
  if (typeof job.pacing !== "object" || Array.isArray(job.pacing)) {
    return null;
  }
  const pacing = job.pacing as Record<string, unknown>;
  const min = normalizeOptionalString(pacing.min);
  const max = normalizeOptionalString(pacing.max);
  try {
    return parseCronPacingBounds({ min, max });
  } catch {
    return null;
  }
}

/** Builds a stable scheduling identity for deciding whether stored timer state is still valid. */
export function tryCronScheduleIdentity(job: CronScheduleIdentityInput): string | undefined {
  const schedule =
    job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule)
      ? schedulePayloadFromRecord(job.schedule as Record<string, unknown>)
      : undefined;
  const pacing = resolvePacingPayload(job);
  if (!schedule || pacing === null) {
    return undefined;
  }
  return JSON.stringify({
    version: 2,
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    schedule: schedule.kind === "event" ? JSON.parse(stableStringify(schedule)) : schedule,
    pacing,
    hasTrigger: job.trigger !== undefined && job.trigger !== null,
  });
}

/** Compares two cron jobs by the normalized inputs that affect next-run computation. */
export function cronSchedulingInputsEqual(
  previous: CronScheduleIdentityInput,
  next: CronScheduleIdentityInput,
): boolean {
  const previousIdentity = tryCronScheduleIdentity(previous);
  const nextIdentity = tryCronScheduleIdentity(next);
  return previousIdentity !== undefined && previousIdentity === nextIdentity;
}
