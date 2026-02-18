import { BudgetTracker } from "./budget-tracker.js";
import { HealthTracker } from "./health-tracker.js";
import { ModelTier, TaskType, type RoutingConfig } from "./types.js";

const MODEL_TIER_ORDER = [ModelTier.TIER1, ModelTier.TIER2, ModelTier.TIER3];

export class ModelSelector {
  private healthTracker?: HealthTracker;
  private budgetTracker?: BudgetTracker;

  constructor(healthTracker?: HealthTracker, budgetTracker?: BudgetTracker) {
    this.healthTracker = healthTracker;
    this.budgetTracker = budgetTracker;
  }

  resolveModels(taskType: TaskType, config: RoutingConfig): string[] {
    // Budget block check — bail out immediately
    if (this.budgetTracker && config.budget?.enabled && this.budgetTracker.shouldBlock()) {
      return [];
    }

    const matrix = config.ha_matrix?.[taskType] ?? config.ha_matrix?.[config.default_task_type];
    if (!matrix) {
      return [];
    }

    // Determine starting tier (budget-aware)
    const startTier =
      this.budgetTracker && config.budget?.enabled
        ? this.budgetTracker.getSuggestedStartTier()
        : ModelTier.TIER1;

    const threshold = config.health?.threshold ?? 0.5;
    const models: string[] = [];
    let started = false;

    for (const tier of MODEL_TIER_ORDER) {
      if (!started && tier !== startTier) {
        continue;
      }
      started = true;

      const model = matrix[tier];
      if (!model) {
        continue;
      }

      // Skip unhealthy models when health tracking is enabled
      if (this.healthTracker && config.health?.enabled) {
        if (!this.healthTracker.isHealthy(model, threshold)) {
          continue;
        }
      }

      models.push(model);
    }

    // Budget critical + degrade: prefer fallback_model if everything else is empty
    if (models.length === 0 && this.budgetTracker && config.budget?.enabled) {
      const fallback = this.budgetTracker.getFallbackModel();
      if (fallback) {
        return [fallback];
      }
    }

    // Safety net: if all tiers were filtered out, return original unfiltered list
    if (models.length === 0) {
      return MODEL_TIER_ORDER.map((t) => matrix[t]).filter((m): m is string => !!m);
    }

    return models;
  }
}
