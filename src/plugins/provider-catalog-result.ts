import { ModelInferenceCapabilitiesSchema } from "@openclaw/model-catalog-core/model-inference-capabilities";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { ProviderCatalogOutcome, ProviderCatalogResult } from "./types.js";

function copyModelIds(value: readonly string[]): string[] {
  return [...new Set(value.map((id) => id.trim()).filter(Boolean))];
}

/** Sparse typed identities never acquire conversational defaults or arbitrary plugin fields. */
export function copyProviderCapabilityModels(value: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    const model = asOptionalRecord(candidate);
    const inference = ModelInferenceCapabilitiesSchema.safeParse(model?.inference);
    if (
      !model ||
      typeof model.provider !== "string" ||
      !model.provider.trim() ||
      typeof model.id !== "string" ||
      !model.id.trim() ||
      typeof model.name !== "string" ||
      !model.name.trim() ||
      typeof model.baseUrl !== "string" ||
      !model.baseUrl.trim() ||
      !inference.success ||
      inference.data.chat ||
      !inference.data.decision
    ) {
      return [];
    }
    return [
      {
        provider: model.provider,
        id: model.id,
        name: model.name,
        baseUrl: model.baseUrl,
        inference: inference.data,
      },
    ];
  });
}

/** Copies admitted discovery facts; provider-specific fields may contain credentials. */
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
      if (entry.capabilityModels) {
        outcome.capabilityModels = copyProviderCapabilityModels(entry.capabilityModels).filter(
          (model) => model.provider === outcome.provider,
        );
      }
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
