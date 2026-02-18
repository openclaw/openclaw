import { ModelTier, TaskType, type RoutingConfig } from "./types.js";

const MODEL_TIER_ORDER = [ModelTier.TIER1, ModelTier.TIER2, ModelTier.TIER3];

export class ModelSelector {
  resolveModels(taskType: TaskType, config: RoutingConfig): string[] {
    const matrix = config.ha_matrix?.[taskType] ?? config.ha_matrix?.[config.default_task_type];
    if (!matrix) {
      return [];
    }
    const models: string[] = [];
    for (const tier of MODEL_TIER_ORDER) {
      const model = matrix[tier];
      if (model) {
        models.push(model);
      }
    }
    return models;
  }
}
