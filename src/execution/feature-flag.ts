/**
 * Feature flag utilities for the Execution Layer.
 *
 * Provides helpers to check if the new execution layer should be used
 * for specific entry points during the gradual migration.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { ExecutionEntryPointFlags } from "./types.js";

/**
 * Entry point identifiers for feature flag checks.
 */
export type ExecutionEntryPoint = keyof ExecutionEntryPointFlags;

/**
 * Check if the new execution layer is enabled for a specific entry point.
 *
 * Resolution order:
 * 1. Check global enabled flag (if false, always use legacy)
 * 2. Check per-entry-point flag
 *
 * @param config - OpenClaw configuration
 * @param entryPoint - Entry point to check
 * @returns true if the new execution layer should be used
 */
export function useNewExecutionLayer(
  config: OpenClawConfig | undefined,
  entryPoint: ExecutionEntryPoint,
): boolean {
  const executionConfig = config?.execution;

  // Global kill switch (defaults to true, meaning per-entry flags are respected)
  if (executionConfig?.enabled === false) {
    return false;
  }

  // Per-entry-point flag (defaults to false, meaning legacy path)
  return executionConfig?.useNewLayer?.[entryPoint] ?? false;
}

/**
 * Check if any entry point has the new execution layer enabled.
 * Useful for logging/diagnostics.
 *
 * @param config - OpenClaw configuration
 * @returns true if any entry point uses the new layer
 */
export function anyNewExecutionLayerEnabled(config: OpenClawConfig | undefined): boolean {
  const executionConfig = config?.execution;

  if (executionConfig?.enabled === false) {
    return false;
  }

  const flags = executionConfig?.useNewLayer;
  if (!flags) {
    return false;
  }

  return Object.values(flags).some((v) => v);
}

/**
 * Get a summary of which entry points are using the new execution layer.
 * Useful for diagnostics and status display.
 *
 * @param config - OpenClaw configuration
 * @returns Object mapping entry points to their enabled status
 */
export function getExecutionLayerStatus(
  config: OpenClawConfig | undefined,
): Record<ExecutionEntryPoint, boolean> {
  const entryPoints: ExecutionEntryPoint[] = [
    "cli",
    "autoReply",
    "followup",
    "cron",
    "hybridPlanner",
  ];

  return Object.fromEntries(
    entryPoints.map((ep) => [ep, useNewExecutionLayer(config, ep)]),
  ) as Record<ExecutionEntryPoint, boolean>;
}
