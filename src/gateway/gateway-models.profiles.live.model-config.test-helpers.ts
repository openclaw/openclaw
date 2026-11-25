import type { ModelProviderConfig } from "../config/types.js";
import { ModelCompatSchema } from "../config/zod-schema.model-compat.js";
import type { Model } from "../llm/types.js";

export function toLiveModelConfig(
  model: Model,
): NonNullable<ModelProviderConfig["models"]>[number] {
  return {
    id: model.id,
    name: model.name,
    api: model.api as ModelProviderConfig["api"],
    // Static metadata can lack a route; an empty runtime URL is not a config override.
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    input: model.input ?? ["text"],
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    cost: {
      ...model.cost,
      ...(model.cost.tieredPricing
        ? {
            tieredPricing: model.cost.tieredPricing.map((tier) => ({
              ...tier,
              range:
                tier.range.length === 2 && tier.range[1] === Number.POSITIVE_INFINITY
                  ? [tier.range[0]]
                  : [...tier.range],
            })),
          }
        : {}),
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: pickConfigModelCompat(model.compat) } : {}),
  };
}

// Runtime normalization can add plugin-internal compat flags (Xiaomi's omitEmptyArrayItems)
// that the config schema rejects; the plugin re-applies them when it resolves the configured model.
const CONFIG_MODEL_COMPAT_KEYS = new Set(Object.keys(ModelCompatSchema.unwrap().shape));

function pickConfigModelCompat(compat: NonNullable<Model["compat"]>) {
  return Object.fromEntries(
    Object.entries(compat).filter(([key]) => CONFIG_MODEL_COMPAT_KEYS.has(key)),
  );
}
