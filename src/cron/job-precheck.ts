import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronJob, CronStoredJob } from "./types.js";

/** Operator-facing refusal when an agent turn tries to persist a host precheck. */
export const CRON_PRECHECK_AGENT_AUTHORING_ERROR =
  "automation shell prechecks cannot be created or edited through the agent automations tool; use the CLI or Gateway API. Omit precheck to edit other fields.";

export const CRON_PRECHECK_MAX_COMMAND_LENGTH = 16_384;
export const CRON_PRECHECK_DEFAULT_TIMEOUT_SECONDS = 30;
export const CRON_PRECHECK_MAX_TIMEOUT_SECONDS = 120;
export const CRON_PRECHECK_MAX_EXIT_CODES = 8;
export const CRON_PRECHECK_DEFAULT_WORK_EXIT_CODES = [0] as const;
export const CRON_PRECHECK_DEFAULT_NO_WORK_EXIT_CODES = [2] as const;

const PRECHECK_FIELDS = new Set(["command", "timeoutSeconds", "workExitCodes", "noWorkExitCodes"]);

/** Canonical precheck stored on a job. Defaults are filled so definition hashes see them. */
export type CronJobPrecheck = {
  command: string;
  timeoutSeconds: number;
  workExitCodes: number[];
  noWorkExitCodes: number[];
};

export type CronJobPrecheckParseResult =
  | { ok: true; value: CronJobPrecheck }
  | { ok: false; reason: string };

/** Outcome of one precheck execution. Denied and error both skip the payload. */
export type CronJobPrecheckResult =
  | { kind: "work"; exitCode: number }
  | { kind: "no-work"; exitCode: number }
  | { kind: "denied"; error: string }
  | { kind: "error"; error: string };

/** Request passed from the cron runner into the host exec owner. */
export type CronJobPrecheckRunRequest = {
  job: CronStoredJob;
  abortSignal?: AbortSignal;
  assertRunCurrent?: () => void | Promise<void>;
};

/** Schedules that fire on the cron timer. Streams and event sources stay on their own owners. */
export function isCronPrecheckScheduleKind(kind: unknown): kind is "at" | "every" | "cron" {
  return kind === "at" || kind === "every" || kind === "cron";
}

function readExitCodes(
  value: unknown,
  label: string,
): { ok: true; codes: number[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > CRON_PRECHECK_MAX_EXIT_CODES) {
    return {
      ok: false,
      reason: `cron precheck ${label} must list 1 to ${CRON_PRECHECK_MAX_EXIT_CODES} exit codes`,
    };
  }
  const codes: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 255) {
      return { ok: false, reason: `cron precheck ${label} must be integers from 0 to 255` };
    }
    if (codes.includes(entry)) {
      return { ok: false, reason: `cron precheck ${label} must not repeat ${entry}` };
    }
    codes.push(entry);
  }
  return { ok: true, codes };
}

/** Parses a precheck, filling defaults. Invalid input stays invalid so callers cannot drop it. */
export function parseCronJobPrecheck(value: unknown): CronJobPrecheckParseResult {
  if (!isRecord(value)) {
    return { ok: false, reason: "cron precheck must be an object" };
  }
  for (const key of Object.keys(value)) {
    if (!PRECHECK_FIELDS.has(key)) {
      return { ok: false, reason: `cron precheck has an unknown field "${key}"` };
    }
  }
  if (typeof value.command !== "string" || value.command.length === 0) {
    return { ok: false, reason: "cron precheck command must be a non-empty string" };
  }
  if (value.command.length > CRON_PRECHECK_MAX_COMMAND_LENGTH) {
    return {
      ok: false,
      reason: `cron precheck command must be at most ${CRON_PRECHECK_MAX_COMMAND_LENGTH} characters`,
    };
  }
  const timeoutSeconds =
    value.timeoutSeconds === undefined
      ? CRON_PRECHECK_DEFAULT_TIMEOUT_SECONDS
      : value.timeoutSeconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > CRON_PRECHECK_MAX_TIMEOUT_SECONDS
  ) {
    return {
      ok: false,
      reason: `cron precheck timeoutSeconds must be an integer from 1 to ${CRON_PRECHECK_MAX_TIMEOUT_SECONDS}`,
    };
  }
  const work =
    value.workExitCodes === undefined
      ? { ok: true as const, codes: [...CRON_PRECHECK_DEFAULT_WORK_EXIT_CODES] }
      : readExitCodes(value.workExitCodes, "workExitCodes");
  if (!work.ok) {
    return work;
  }
  const noWork =
    value.noWorkExitCodes === undefined
      ? { ok: true as const, codes: [...CRON_PRECHECK_DEFAULT_NO_WORK_EXIT_CODES] }
      : readExitCodes(value.noWorkExitCodes, "noWorkExitCodes");
  if (!noWork.ok) {
    return noWork;
  }
  const overlap = work.codes.find((code) => noWork.codes.includes(code));
  if (overlap !== undefined) {
    return {
      ok: false,
      reason: `cron precheck exit code ${overlap} cannot mean both work and no work`,
    };
  }
  return {
    ok: true,
    value: {
      command: value.command,
      timeoutSeconds,
      workExitCodes: work.codes,
      noWorkExitCodes: noWork.codes,
    },
  };
}

/** Returns the canonical precheck, or the original value when it must fail validation. */
export function canonicalCronPrecheck(value: unknown): unknown {
  const parsed = parseCronJobPrecheck(value);
  return parsed.ok ? parsed.value : value;
}

/**
 * Stores a canonical precheck. Invalid input is preserved so validation still
 * sees the field; dropping it would save a job that runs with no probe.
 */
export function coerceStoredCronPrecheck(value: unknown): NonNullable<CronJob["precheck"]> {
  // SAFETY: invalid prechecks stay stored so quarantine can reject them; callers parse before execution.
  return canonicalCronPrecheck(value) as NonNullable<CronJob["precheck"]>;
}
