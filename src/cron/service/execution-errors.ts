/** Formats stable cron timeout and execution error messages. */
import { formatEmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";
import type { CronAgentExecutionStarted } from "../types.js";

function formatCronAgentExecutionPhase(execution?: CronAgentExecutionStarted): string | undefined {
  return formatEmbeddedAgentExecutionPhase(execution?.phase);
}

/** Formats the generic cron execution timeout message with last-known phase context when available. */
export function timeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return "cron: job execution timed out";
  }
  return `cron: job execution timed out (last phase: ${phase})`;
}

/** Formats timeout text for runs that stalled before the isolated runner started. */
export function setupTimeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return "cron: isolated agent setup timed out before runner start";
  }
  return `cron: isolated agent setup timed out before runner start (last phase: ${phase})`;
}

/** Returns true for the setup-timeout class that fires before the isolated runner starts. */
export function isSetupTimeoutErrorText(error: string): boolean {
  return error.startsWith("cron: isolated agent setup timed out before runner start");
}

/** Formats timeout text for runs that stalled after setup but before execution start. */
export function preExecutionTimeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return "cron: isolated agent run stalled before execution start";
  }
  return `cron: isolated agent run stalled before execution start (last phase: ${phase})`;
}

/** Extracts a human timeout/abort reason, falling back to the canonical cron timeout text. */
export function resolveCronAbortReasonText(reason: unknown): string | undefined {
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message.trim();
  }
  return undefined;
}

/** Extracts a human timeout/abort reason, falling back to the canonical cron timeout text. */
export function abortErrorMessage(signal?: AbortSignal): string {
  return resolveCronAbortReasonText(signal?.reason) ?? timeoutErrorMessage();
}

/** True when the cron wall-clock watchdog aborted the shared isolated run signal. */
export function isCronWallClockTimeoutAbort(signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  const reason = signal.reason;
  return reason instanceof Error && reason.name === "TimeoutError";
}

/**
 * Cron timeout aborts the active attempt, but configured fallback models should
 * still run instead of inheriting the already-aborted shared signal.
 */
export function resolveCronFallbackRunAbortSignal(params: {
  abortSignal?: AbortSignal;
}): AbortSignal | undefined {
  if (!params.abortSignal?.aborted) {
    return params.abortSignal;
  }
  if (isCronWallClockTimeoutAbort(params.abortSignal)) {
    return undefined;
  }
  return params.abortSignal;
}

/** True when a timed-out cron run still produced a visible assistant answer to keep. */
export function isCronRecoverableTimeoutAbort(params: {
  abortSignal?: AbortSignal;
  hasVisibleAssistantReply: boolean;
}): boolean {
  return isCronWallClockTimeoutAbort(params.abortSignal) && params.hasVisibleAssistantReply;
}

/** True when finalize should return the cron abort error instead of the recovered answer. */
export function shouldHonorCronRunAbortOutcome(params: {
  isAborted: () => boolean;
  abortSignal?: AbortSignal;
  hasVisibleAssistantReply: boolean;
}): boolean {
  if (!params.isAborted()) {
    return false;
  }
  return !isCronRecoverableTimeoutAbort({
    abortSignal: params.abortSignal,
    hasVisibleAssistantReply: params.hasVisibleAssistantReply,
  });
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === "AbortError" || err.message === timeoutErrorMessage();
}

/** Normalizes thrown cron run failures into stable log/run-log text. */
export function normalizeCronRunErrorText(err: unknown): string {
  if (isAbortError(err)) {
    return timeoutErrorMessage();
  }
  if (typeof err === "string") {
    return err === `Error: ${timeoutErrorMessage()}` ? timeoutErrorMessage() : err;
  }
  return String(err);
}
