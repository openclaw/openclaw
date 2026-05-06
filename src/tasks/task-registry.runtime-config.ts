import type { TasksConfig } from "../config/types.tasks.js";

/**
 * Default retention for terminal task records before they are eligible for
 * pruning by the maintenance sweep. Seven days.
 */
export const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Default cadence for the task registry maintenance sweep. One minute.
 */
export const DEFAULT_TASK_SWEEP_INTERVAL_MS = 60_000;

let resolvedTaskRetentionMs = DEFAULT_TASK_RETENTION_MS;
let resolvedTaskSweepIntervalMs = DEFAULT_TASK_SWEEP_INTERVAL_MS;

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const truncated = Math.trunc(value);
  if (truncated <= 0) {
    return fallback;
  }
  return truncated;
}

/**
 * Apply user-supplied task registry config. Falls back to defaults for any
 * missing or invalid values. Idempotent: safe to call repeatedly during
 * bootstrap or on hot-reload.
 */
export function applyTasksConfig(config: TasksConfig | undefined): void {
  resolvedTaskRetentionMs = clampPositiveInt(config?.retentionMs, DEFAULT_TASK_RETENTION_MS);
  resolvedTaskSweepIntervalMs = clampPositiveInt(
    config?.sweepIntervalMs,
    DEFAULT_TASK_SWEEP_INTERVAL_MS,
  );
}

/** Current effective retention in milliseconds. */
export function getTaskRetentionMs(): number {
  return resolvedTaskRetentionMs;
}

/** Current effective sweep interval in milliseconds. */
export function getTaskSweepIntervalMs(): number {
  return resolvedTaskSweepIntervalMs;
}

/** Test helper: reset all resolved values to defaults. */
export function resetTaskRegistryRuntimeConfigForTests(): void {
  resolvedTaskRetentionMs = DEFAULT_TASK_RETENTION_MS;
  resolvedTaskSweepIntervalMs = DEFAULT_TASK_SWEEP_INTERVAL_MS;
}
