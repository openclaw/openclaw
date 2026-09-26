import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import type {
  ModelCatalog,
  ModelCatalogModel,
  ModelDecisionCapabilities,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizeManifestDecisionModels } from "./manifest-capability-normalizers.js";

/** The documented V1 manifest is an input adapter, not a second catalog. */
export function normalizeManifestModelCatalog(params: {
  modelCatalog: unknown;
  decisionModels: unknown;
  providers: readonly string[];
  cliBackends: readonly string[];
  decisionProviders?: readonly string[];
}): ModelCatalog | undefined {
  const ownedProviders = new Set([
    ...params.providers,
    ...params.cliBackends,
    ...(params.decisionProviders ?? []),
  ]);
  const catalog = normalizeModelCatalog(params.modelCatalog, { ownedProviders });
  const legacy = normalizeManifestDecisionModels(params.decisionModels, params.decisionProviders);
  if (!legacy?.length) {
    return catalog;
  }
  // Reserve explicit identities before validation: a rejected canonical declaration
  // must not be resurrected as an apparently usable legacy capability.
  const declaredModels = new Map<string, Set<string>>();
  if (isRecord(params.modelCatalog) && isRecord(params.modelCatalog.providers)) {
    for (const [id, provider] of Object.entries(params.modelCatalog.providers)) {
      if (!isRecord(provider) || !Array.isArray(provider.models)) {
        continue;
      }
      const key = normalizeProviderId(id);
      const ids = declaredModels.get(key) ?? new Set<string>();
      for (const row of provider.models) {
        const modelId = isRecord(row) ? normalizeOptionalString(row.id) : undefined;
        if (modelId) {
          ids.add(modelId);
        }
      }
      declaredModels.set(key, ids);
    }
  }
  const providers = { ...catalog?.providers };
  for (const model of legacy) {
    const provider = normalizeProviderId(model.provider);
    if (!provider || isBlockedObjectKey(provider)) {
      continue;
    }
    const current = providers[provider];
    // An explicit canonical declaration owns the entire row, never a blended contract.
    if (declaredModels.get(provider)?.has(model.id)) {
      continue;
    }
    const capabilities = model.capabilities;
    const questions: NonNullable<ModelDecisionCapabilities["questions"]> = {};
    for (const kind of capabilities?.questionTypes ?? []) {
      questions[kind] = {
        // V1 reports estimates, but never promises categorical normalization or abstention.
        probabilities: kind === "boolean" ? "boolean" : "provider-defined",
        abstention: false,
        ...(kind === "boolean" && capabilities?.requiresBooleanCriteria !== undefined
          ? { requiresCriteria: capabilities.requiresBooleanCriteria }
          : {}),
        ...(kind === "choice" && capabilities?.maxChoiceAlternatives !== undefined
          ? { maxOptions: capabilities.maxChoiceAlternatives }
          : {}),
        ...(kind === "score" && capabilities?.maxScoreLevels !== undefined
          ? { maxOptions: capabilities.maxScoreLevels }
          : {}),
      };
    }
    const row: ModelCatalogModel = {
      id: model.id,
      name: model.name,
      inference: {
        chat: false,
        decision: {
          protocol: "decision-v1",
          input: ["text"],
          ...(capabilities
            ? {
                questions,
                ...(capabilities.confidence ? { confidence: capabilities.confidence } : {}),
                limits: {
                  ...(capabilities.maxQuestions !== undefined
                    ? { maxQuestions: capabilities.maxQuestions }
                    : {}),
                  ...(capabilities.maxInputTokens !== undefined
                    ? { maxInputTokens: capabilities.maxInputTokens }
                    : {}),
                  ...(capabilities.inputTokenScope
                    ? { inputTokenScope: capabilities.inputTokenScope }
                    : {}),
                },
              }
            : {}),
        },
      },
    };
    providers[provider] = { ...current, models: [...(current?.models ?? []), row] };
  }
  return normalizeModelCatalog({ ...catalog, providers }, { ownedProviders });
}
