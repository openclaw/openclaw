/** Formats stable cron timeout and execution error messages. */
import { formatEmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";
import type { CronAgentExecutionStarted } from "../types.js";

const MAX_RUNTIME_PLUGIN_DIAGNOSTIC_IDS = 12;

function formatCronAgentExecutionPhase(execution?: CronAgentExecutionStarted): string | undefined {
  return formatEmbeddedAgentExecutionPhase(execution?.phase);
}

function formatRuntimePluginIds(ids: readonly string[] | undefined): string | undefined {
  if (!ids || ids.length === 0) {
    return undefined;
  }
  const visible = ids.slice(0, MAX_RUNTIME_PLUGIN_DIAGNOSTIC_IDS);
  const suffix = ids.length > visible.length ? `, +${ids.length - visible.length} more` : "";
  return `[${visible.join(", ")}${suffix}]`;
}

function formatRuntimePluginLoadDiagnostics(
  execution?: CronAgentExecutionStarted,
): string | undefined {
  const runtimePlugins = execution?.runtimePlugins;
  if (!runtimePlugins) {
    return undefined;
  }
  if (execution?.phase !== "runtime_plugins") {
    return undefined;
  }
  const parts: string[] = [];
  const attempted = formatRuntimePluginIds(runtimePlugins.pluginIds);
  if (attempted) {
    parts.push(`attempted=${attempted}`);
  }
  const completed = formatRuntimePluginIds(runtimePlugins.completedPluginIds);
  if (completed) {
    parts.push(`completed=${completed}`);
  }
  if (runtimePlugins.inFlightPluginId) {
    parts.push(
      `in-flight=${runtimePlugins.inFlightPluginId}${
        runtimePlugins.inFlightPhase ? `/${runtimePlugins.inFlightPhase}` : ""
      }`,
    );
  }
  return parts.length > 0 ? `; runtime plugins: ${parts.join("; ")}` : undefined;
}

function formatCronAgentExecutionPhaseSuffix(
  execution?: CronAgentExecutionStarted,
): string | undefined {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return undefined;
  }
  return `${phase}${formatRuntimePluginLoadDiagnostics(execution) ?? ""}`;
}

/** Formats the generic cron execution timeout message with last-known phase context when available. */
export function timeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhaseSuffix(execution);
  if (!phase) {
    return "cron: job execution timed out";
  }
  return `cron: job execution timed out (last phase: ${phase})`;
}

/** Formats timeout text for runs that stalled before the isolated runner started. */
export function setupTimeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhaseSuffix(execution);
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
  const phase = formatCronAgentExecutionPhaseSuffix(execution);
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
