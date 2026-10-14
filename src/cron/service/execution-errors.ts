/** Formats stable cron timeout and execution error messages. */
import { formatEmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";
import { extractErrorCode, formatErrorMessageWithCode } from "../../infra/errors.js";
import {
  CRON_JOB_EXECUTION_TIMEOUT_ERROR,
  CRON_PRE_EXECUTION_TIMEOUT_ERROR,
  CRON_SETUP_TIMEOUT_ERROR,
  isCronTimeoutErrorText,
} from "../execution-error-constants.js";
import type { CronAgentExecutionStarted, CronRunErrorClassification } from "../types.js";

function formatCronTimeoutMessage(message: string, execution?: CronAgentExecutionStarted): string {
  const phase = formatEmbeddedAgentExecutionPhase(execution?.phase);
  return phase ? `${message} (last phase: ${phase})` : message;
}

export function isCronTerminalAbortReasonText(error: string): boolean {
  return isCronTimeoutErrorText(error);
}

/** Formats the generic cron execution timeout message with last-known phase context when available. */
export function timeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  return formatCronTimeoutMessage(CRON_JOB_EXECUTION_TIMEOUT_ERROR, execution);
}

/** Formats timeout text for runs that stalled before the isolated runner started. */
export function setupTimeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  return formatCronTimeoutMessage(CRON_SETUP_TIMEOUT_ERROR, execution);
}

/** Returns true for the setup-timeout class that fires before the isolated runner starts. */
export function isSetupTimeoutErrorText(error: string): boolean {
  return error === CRON_SETUP_TIMEOUT_ERROR || error.startsWith(CRON_SETUP_TIMEOUT_ERROR + " ");
}

/** Formats timeout text for runs that stalled after setup but before execution start. */
export function preExecutionTimeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  return formatCronTimeoutMessage(CRON_PRE_EXECUTION_TIMEOUT_ERROR, execution);
}

/** Extracts a human timeout/abort reason, falling back to the canonical cron timeout text. */
export function resolveCronAbortReasonText(reason: unknown): string | undefined {
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  if (reason instanceof Error) {
    const message = reason.message.trim();
    // Only an empty abort or one already carrying cron's canonical timeout text
    // is unspecified. Coded aborts and other messages retain their exact reason.
    if (extractErrorCode(reason) === undefined && (!message || message === timeoutErrorMessage())) {
      return undefined;
    }
    return formatErrorMessageWithCode(reason);
  }
  return undefined;
}

/** Extracts a human timeout/abort reason, falling back to the canonical cron timeout text. */
export function abortErrorMessage(signal?: AbortSignal): string {
  return resolveCronAbortReasonText(signal?.reason) ?? timeoutErrorMessage();
}

/** The controller owns whether an interruption was a watchdog timeout or a cancellation. */
export function cronAbortErrorClassification(signal?: AbortSignal): CronRunErrorClassification {
  return !signal || (signal.reason instanceof Error && signal.reason.name === "TimeoutError")
    ? { kind: "reason", reason: "timeout" }
    : { kind: "aborted" };
}

/** Normalizes thrown cron run failures into stable log/run-history text. */
export function normalizeCronRunErrorText(err: unknown): string {
  if (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.trim() === timeoutErrorMessage())
  ) {
    return resolveCronAbortReasonText(err) ?? timeoutErrorMessage();
  }
  return formatErrorMessageWithCode(err);
}
