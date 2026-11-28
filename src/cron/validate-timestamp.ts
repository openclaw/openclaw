/** Validates user-supplied one-shot cron timestamps before scheduling. */
import {
  asDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAbsoluteTimeMs } from "./parse.js";
import type { CronSchedule } from "./types.js";

const ONE_MINUTE_MS = 60 * 1000;
const ONE_DAY_MS = 24 * 60 * ONE_MINUTE_MS;
const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

type TimestampValidationError = {
  ok: false;
  message: string;
};

type TimestampValidationSuccess = {
  ok: true;
};

type TimestampValidationResult = TimestampValidationSuccess | TimestampValidationError;

/**
 * Validates one-shot cron timestamps with a small past grace window and far-future cap.
 */
export function validateScheduleTimestamp(
  schedule: CronSchedule,
  nowMs: number = Date.now(),
): TimestampValidationResult {
  if (schedule.kind !== "at") {
    return { ok: true };
  }

  const atRaw = normalizeOptionalString(schedule.at) ?? "";
  const atMs = atRaw ? parseAbsoluteTimeMs(atRaw) : null;
  const referenceNowMs = asDateTimestampMs(nowMs) ?? asDateTimestampMs(Date.now()) ?? 0;

  if (atMs === null || !Number.isFinite(atMs)) {
    const example = resolveTimestampMsToIsoString(referenceNowMs + ONE_DAY_MS);
    return {
      ok: false,
      message: `OpenClaw couldn’t read the scheduled time. Enter a future date and time, such as ${example}.`,
    };
  }

  const diffMs = atMs - referenceNowMs;

  // Allow a one-minute grace window so creation and validation races do not
  // reject freshly submitted one-shot jobs.
  if (diffMs < -ONE_MINUTE_MS) {
    const nowDate = resolveTimestampMsToIsoString(referenceNowMs);
    const atDate = resolveTimestampMsToIsoString(atMs);
    return {
      ok: false,
      message: `That time is in the past (${atDate}). Choose a time after ${nowDate}.`,
    };
  }

  // Bound far-future one-shot jobs so mistyped years do not persist forever.
  if (diffMs > TEN_YEARS_MS) {
    const atDate = resolveTimestampMsToIsoString(atMs);
    return {
      ok: false,
      message: `The scheduled time (${atDate}) is more than 10 years away. Choose an earlier date and time.`,
    };
  }

  return { ok: true };
}
