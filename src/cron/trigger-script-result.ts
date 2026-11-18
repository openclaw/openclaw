import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import type { CronTriggerEvaluationResult, CronTriggerFailureCode } from "./types.js";

const MAX_TRIGGER_STATE_BYTES = 16 * 1024;

function scriptResultCandidate(result: Extract<CodeModeHeadlessResult, { status: "completed" }>) {
  if (isRecord(result.value)) {
    return result.value;
  }
  for (let index = result.output.length - 1; index >= 0; index -= 1) {
    const entry = result.output[index];
    if (isRecord(entry) && entry.type === "json") {
      return entry.value;
    }
  }
  return undefined;
}

export function scriptFailure(
  error: string,
  code: CronTriggerFailureCode = "internal_error",
): Extract<CronTriggerEvaluationResult, { kind: "error" }> {
  return { kind: "error", code, error };
}

function validateCronState(candidate: Record<string, unknown>, label: string) {
  if (!Object.hasOwn(candidate, "state")) {
    return { ok: true as const, stateChanged: false as const };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(candidate.state);
  } catch (error) {
    return {
      ok: false as const,
      code: "internal_error" as const,
      error: `${label} state is not JSON-serializable: ${formatErrorMessageWithCode(error)}`,
    };
  }
  if (serialized === undefined) {
    return {
      ok: false as const,
      code: "internal_error" as const,
      error: `${label} state is not JSON-serializable`,
    };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_TRIGGER_STATE_BYTES) {
    return {
      ok: false as const,
      code: "output_limit_exceeded" as const,
      error: `${label} state exceeds the 16KB limit`,
    };
  }
  return {
    ok: true as const,
    stateChanged: true as const,
    state: JSON.parse(serialized) as unknown,
  };
}

export function parseCheckResult(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
): CronTriggerEvaluationResult {
  const candidate = scriptResultCandidate(result);
  if (!isRecord(candidate)) {
    return scriptFailure("cron check must return an object");
  }
  if (
    (candidate.post !== undefined && typeof candidate.post !== "string") ||
    (candidate.wake !== undefined && typeof candidate.wake !== "string") ||
    (candidate.post !== undefined && candidate.wake !== undefined) ||
    Object.hasOwn(candidate, "fire") ||
    Object.hasOwn(candidate, "notify")
  ) {
    return scriptFailure(
      "cron check must return at most one of post or wake, with a string message",
      "invalid_input",
    );
  }
  let nextCheck: { delayMs: number } | undefined;
  if (candidate.nextCheck !== undefined) {
    if (typeof candidate.nextCheck !== "string") {
      return scriptFailure("cron check nextCheck must be a duration string");
    }
    try {
      const delayMs = parseDurationMs(candidate.nextCheck);
      if (delayMs <= 0) {
        throw new Error("duration must be positive");
      }
      nextCheck = { delayMs };
    } catch {
      return scriptFailure("cron check nextCheck must be a positive duration");
    }
  }
  const state = validateCronState(candidate, "cron check");
  if (!state.ok) {
    return scriptFailure(state.error, state.code);
  }
  return {
    kind: "evaluated",
    action:
      candidate.wake !== undefined
        ? "wake"
        : typeof candidate.post === "string" && candidate.post.trim()
          ? "post"
          : "quiet",
    ...(typeof candidate.wake === "string"
      ? { message: candidate.wake }
      : typeof candidate.post === "string"
        ? { message: candidate.post }
        : {}),
    ...(state.stateChanged ? { state: state.state } : {}),
    ...(nextCheck ? { nextCheck } : {}),
  };
}
