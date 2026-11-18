import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { isRecord } from "./legacy-config-record-shared.js";

const MISTRAL_MODEL_CACHE_READ_COST_BY_ID = new Map([
  ["codestral-latest", 0.03],
  ["devstral-medium-latest", 0.04],
  ["magistral-small", 0.05],
  ["mistral-large-latest", 0.05],
  ["mistral-medium-2508", 0.04],
  ["mistral-medium-3-5", 0.15],
  ["mistral-small-latest", 0.01],
  ["pixtral-large-latest", 0.2],
]);

export function normalizeLegacyMistralModelCost<T extends Record<string, unknown>>(params: {
  providerId: string;
  model: T;
  modelId: string;
  index: number;
  changes: string[];
}): T {
  const cost = params.model.cost;
  if (!isRecord(cost) || cost.cacheRead !== 0) {
    return params.model;
  }

  const normalizedCacheRead = MISTRAL_MODEL_CACHE_READ_COST_BY_ID.get(params.modelId.toLowerCase());
  if (normalizedCacheRead === undefined) {
    return params.model;
  }

  params.changes.push(
    `Normalized models.providers.${sanitizeForLog(params.providerId)}.models[${params.index}].cost.cacheRead (0 → ${normalizedCacheRead}) for Mistral prompt-cache billing.`,
  );
  return {
    ...params.model,
    cost: { ...cost, cacheRead: normalizedCacheRead },
  };
}
