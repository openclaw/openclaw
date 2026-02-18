/**
 * Routing singleton module — Phase 4
 *
 * Provides a lazily-initialized singleton that bundles:
 *   - HealthTracker
 *   - BudgetTracker
 *   - ReviewGate
 *   - ModelSelector (constructed with health + budget trackers)
 *
 * The singleton is keyed on the RoutingConfig object reference.  When a new
 * config is detected (e.g. config reload) pass the new config and a fresh
 * instance will be created.
 */

import { BudgetTracker } from "./budget-tracker.js";
import { HealthTracker } from "./health-tracker.js";
import { ModelSelector } from "./model-selector.js";
import { ReviewGate } from "./review-gate.js";
import type { RoutingConfig } from "./types.js";

export interface RoutingInstance {
  healthTracker: HealthTracker;
  budgetTracker: BudgetTracker;
  reviewGate: ReviewGate;
  selector: ModelSelector;

  /** Serialize health + budget state for persistence */
  serialize(): { health: string; budget: string };

  /**
   * Restore health + budget state from previously serialized data.
   * Silently ignores malformed input.
   */
  deserialize(data: { health: string; budget: string }): void;
}

// Singleton storage — one instance per RoutingConfig reference.
let _currentConfig: RoutingConfig | undefined;
let _instance: RoutingInstance | undefined;

/**
 * Return (or lazily create) the routing singleton for a given config.
 *
 * If the config object reference changes a new instance is constructed and
 * the previous one is discarded.
 */
export function getRoutingInstance(config: RoutingConfig): RoutingInstance {
  if (_instance && _currentConfig === config) {
    return _instance;
  }

  // Build sub-components from config
  const healthTracker = new HealthTracker(config.health?.window_size ?? 20);

  // BudgetConfig is required by BudgetTracker — provide a safe default when
  // the budget section is absent from config.
  const budgetConfig = config.budget ?? {
    enabled: false,
    daily_budget_usd: 0,
    daily_token_limit: 0,
    warning_threshold: 0.8,
    critical_action: "degrade" as const,
  };
  const budgetTracker = new BudgetTracker(budgetConfig);

  // ReviewGateConfig — provide a safe default when absent.
  const reviewGateConfig = config.review_gate ?? {
    enabled: false,
    mode: "manual" as const,
    high_risk_types: [],
    reviewer_model: "",
    reviewer_system_prompt: "",
    timeout_ms: 60_000,
  };
  const reviewGate = new ReviewGate(reviewGateConfig);

  const selector = new ModelSelector(healthTracker, budgetTracker);

  const instance: RoutingInstance = {
    healthTracker,
    budgetTracker,
    reviewGate,
    selector,

    serialize() {
      return {
        health: healthTracker.serialize(),
        budget: budgetTracker.serialize(),
      };
    },

    deserialize(data: { health: string; budget: string }) {
      try {
        if (data.health) {
          healthTracker.deserialize(data.health);
        }
      } catch {
        // ignore malformed health data
      }
      try {
        if (data.budget) {
          budgetTracker.deserialize(data.budget);
        }
      } catch {
        // ignore malformed budget data
      }
    },
  };

  _currentConfig = config;
  _instance = instance;
  return instance;
}

/**
 * Reset the singleton (primarily for testing).
 */
export function resetRoutingInstance(): void {
  _currentConfig = undefined;
  _instance = undefined;
}
