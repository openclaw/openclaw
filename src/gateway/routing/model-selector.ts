import { HealthTracker } from "./health-tracker.js";
import { ModelTier, TaskType, type RoutingConfig } from "./types.js";

const MODEL_TIER_ORDER = [ModelTier.TIER1, ModelTier.TIER2, ModelTier.TIER3];

export class ModelSelector {
  private healthTracker?: HealthTracker;

  constructor(healthTracker?: HealthTracker) {
    this.healthTracker = healthTracker;
  }

  resolveModels(taskType: TaskType, config: RoutingConfig): string[] {
    const matrix = config.ha_matrix?.[taskType] ?? config.ha_matrix?.[config.default_task_type];
    if (!matrix) {
      return [];
    }

    const threshold = config.health?.threshold ?? 0.5;
    const models: string[] = [];

    for (const tier of MODEL_TIER_ORDER) {
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

    // Fallback: if all tiers were filtered out, return the full unfiltered list
    if (models.length === 0) {
      return MODEL_TIER_ORDER.map((tier) => matrix[tier]).filter((m): m is string => !!m);
    }

    return models;
  }
}
