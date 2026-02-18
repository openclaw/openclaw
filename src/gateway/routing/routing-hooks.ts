/**
 * Routing hooks — Phase 4
 *
 * Post-reply hook that feeds real call results back into HealthTracker and
 * BudgetTracker via the routing singleton.
 *
 * Usage (once wired):
 *   import { recordRoutingResult } from "../routing/routing-hooks.js";
 *   recordRoutingResult({ model, success, latencyMs, promptTokens, completionTokens, costUsd });
 */

import type { UsageRecord } from "./budget-tracker.js";
import { getRoutingInstance } from "./routing-instance.js";
import type { RoutingConfig } from "./types.js";

export interface RoutingResultParams {
  model: string;
  success: boolean;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
}

/**
 * Record a completed model call into HealthTracker + BudgetTracker.
 *
 * @param config   The RoutingConfig that was active when the call was made.
 * @param params   Call result metadata.
 */
export function recordRoutingResult(config: RoutingConfig, params: RoutingResultParams): void {
  const instance = getRoutingInstance(config);
  const now = Date.now();

  // Feed HealthTracker
  instance.healthTracker.recordResult(params.model, {
    timestamp: now,
    success: params.success,
    latencyMs: params.latencyMs,
  });

  // Feed BudgetTracker (only when budget tracking is enabled)
  if (config.budget?.enabled) {
    const usage: UsageRecord = {
      model: params.model,
      prompt_tokens: params.promptTokens ?? 0,
      completion_tokens: params.completionTokens ?? 0,
      cost_usd: params.costUsd ?? 0,
      timestamp: now,
    };
    instance.budgetTracker.recordUsage(usage);
  }
}
