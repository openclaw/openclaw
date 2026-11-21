import type { ModelProviderConfig } from "../config/types.js";
import type { ProviderCatalogOutcome, ProviderCatalogResult } from "./types.js";

function copyModelIds(value: readonly string[]): string[] {
  return [...new Set(value.map((id) => id.trim()).filter(Boolean))];
}

/** Projects only diagnostic fields; provider-specific fields may contain credentials. */
export function copyProviderCatalogOutcomes(
  result: { outcomes?: readonly ProviderCatalogOutcome[] } | null | undefined,
): ProviderCatalogOutcome[] {
  return (result?.outcomes ?? []).map((entry) => {
    const outcome: ProviderCatalogOutcome = {
      provider: entry.provider.trim(),
      status: entry.status,
    };
    if (entry.profileId) {
      outcome.profileId = entry.profileId.trim();
    }
    if (entry.rejectionScope) {
      outcome.rejectionScope = entry.rejectionScope;
    }
    if (entry.status === "ready") {
      if (entry.modelAccessPrograms) {
        outcome.modelAccessPrograms = entry.modelAccessPrograms.map((model) => ({
          ...model,
          cyber: [...model.cyber],
        }));
      }
      if (entry.modelServiceTiers) {
        outcome.modelServiceTiers = entry.modelServiceTiers.map((model) => ({
          modelId: model.modelId.trim(),
          runtimeId: model.runtimeId.trim(),
          api: model.api.trim(),
          baseUrl: model.baseUrl.trim(),
          serviceTiers: copyModelIds(model.serviceTiers),
        }));
      }
      const modelOrder = entry.modelOrder ? copyModelIds(entry.modelOrder) : [];
      if (modelOrder.length > 0) {
        outcome.modelOrder = modelOrder;
      }
      // An empty successful listing remains authoritative.
      if (entry.listedModelIds) {
        outcome.listedModelIds = copyModelIds(entry.listedModelIds);
      }
      if (entry.modelIdCatalog) {
        outcome.modelIdCatalog = {
          baseUrl: entry.modelIdCatalog.baseUrl,
          modelIds: copyModelIds(entry.modelIdCatalog.modelIds),
        };
        if (entry.modelIdCatalog.aliases) {
          outcome.modelIdCatalog.aliases = copyModelIds(entry.modelIdCatalog.aliases);
        }
      }
    }
    return outcome;
  });
}

/** Reads admitted plugin values by reference, applying aliases only to single-provider results. */
export function readProviderCatalogResultEntries(params: {
  providerId: string;
  aliases?: readonly string[];
  result: ProviderCatalogResult;
}): Array<[string, ModelProviderConfig]> {
  const result = params.result;
  if (!result) {
    return [];
  }
  return "provider" in result
    ? [params.providerId, ...(params.aliases ?? [])].map((id) => [id, result.provider])
    : Object.entries(result.providers);
}
