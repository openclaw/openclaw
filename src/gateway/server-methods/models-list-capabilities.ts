import type {
  ModelCatalogModel,
  ModelDecisionCapabilities,
} from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createPreparedModelCatalogProviderNormalizer } from "../../agents/model-catalog-provider-normalizer.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listAvailableManifestContractPlugins } from "../../plugins/manifest-contract-eligibility.js";
import type { DecisionProviderCapabilities } from "../../plugins/manifest-types.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

export class UnknownModelCatalogProviderError extends Error {}

// The public selector is a bounded V1 view of the canonical route capabilities.
// Legacy manifests are normalized into modelCatalog by the manifest owner.
function selectorCapabilities(
  decision: ModelDecisionCapabilities,
): DecisionProviderCapabilities | undefined {
  const questionTypes = (["boolean", "choice", "score"] as const).filter(
    (kind) => decision.questions?.[kind],
  );
  if (!questionTypes.length) {
    return undefined;
  }
  const capabilities: DecisionProviderCapabilities = { questionTypes };
  const limits = decision.limits;
  if (limits?.maxQuestions !== undefined) {
    capabilities.maxQuestions = limits.maxQuestions;
  }
  if (limits?.maxInputTokens !== undefined) {
    capabilities.maxInputTokens = limits.maxInputTokens;
  }
  if (limits?.inputTokenScope !== undefined) {
    capabilities.inputTokenScope = limits.inputTokenScope;
  }
  if (decision.questions?.choice?.maxOptions !== undefined) {
    capabilities.maxChoiceAlternatives = decision.questions.choice.maxOptions;
  }
  if (decision.questions?.score?.maxOptions !== undefined) {
    capabilities.maxScoreLevels = decision.questions.score.maxOptions;
  }
  if (decision.questions?.boolean?.requiresCriteria !== undefined) {
    capabilities.requiresBooleanCriteria = decision.questions.boolean.requiresCriteria;
  }
  if (decision.confidence !== undefined) {
    capabilities.confidence = decision.confidence;
  }
  return capabilities;
}

export function listDecisionModels({
  config,
  snapshot,
  catalog,
}: {
  config: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
  catalog: readonly ModelCatalogEntry[];
}) {
  const decisionModels: NonNullable<ModelsListResult["decisionModels"]> = [];
  if (config.plugins?.enabled !== false) {
    const normalizeProvider = createPreparedModelCatalogProviderNormalizer(snapshot, config);
    const byProvider = new Map<string, ModelCatalogEntry[]>();
    for (const row of catalog) {
      const provider = normalizeProvider(row.provider);
      const rows = byProvider.get(provider) ?? [];
      rows.push(row);
      byProvider.set(provider, rows);
    }
    const seen = new Set<string>();
    for (const plugin of listAvailableManifestContractPlugins({
      snapshot,
      config,
      contract: "decisionProviders",
    })) {
      // Metadata identifies an installed adapter; advertised facts never register one.
      for (const provider of plugin.contracts?.decisionProviders ?? []) {
        const canonical = normalizeProvider(provider);
        const models = new Map<string, Pick<ModelCatalogModel, "id" | "name" | "inference">>();
        for (const row of byProvider.get(canonical) ?? []) {
          if (!models.has(row.id)) {
            models.set(row.id, row);
          }
        }
        // Installed adapters retain their existing selector advertisement, including custom
        // routes and replace mode. This projection never restores prepared execution facts.
        for (const row of plugin.modelCatalog?.providers?.[provider]?.models ?? []) {
          if (!models.get(row.id)?.inference?.decision) {
            models.set(row.id, row);
          }
        }
        for (const model of models.values()) {
          const decision = model.inference?.decision;
          const key = `${canonical}/${model.id}`;
          if (!decision || seen.has(key)) {
            continue;
          }
          const capabilities = selectorCapabilities(decision);
          decisionModels.push({
            provider,
            id: model.id,
            name: model.name ?? model.id,
            pluginId: plugin.id,
            ...(capabilities ? { capabilities } : {}),
          });
          seen.add(key);
        }
      }
    }
  }
  return decisionModels;
}

export function createModelsListProviderFilter(params: {
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  catalog: readonly { provider: string }[];
  provider?: string;
}) {
  const { config, metadataSnapshot, catalog } = params;
  const normalizeProvider = createPreparedModelCatalogProviderNormalizer(metadataSnapshot, config);
  const providerFilter = params.provider ? normalizeProvider(params.provider) : undefined;
  if (providerFilter) {
    const decisionProviderIds = (
      metadataSnapshot.owners.contracts.get("decisionProviders") ?? []
    ).flatMap(
      (pluginId) => metadataSnapshot.byPluginId.get(pluginId)?.contracts?.decisionProviders ?? [],
    );
    const knownProviders = new Set(
      [
        ...metadataSnapshot.owners.providers.keys(),
        ...metadataSnapshot.owners.modelCatalogProviders.keys(),
        ...decisionProviderIds,
        ...Object.keys(config.models?.providers ?? {}),
        ...catalog.map((entry) => entry.provider),
      ].map(normalizeProvider),
    );
    if (!knownProviders.has(providerFilter)) {
      throw new UnknownModelCatalogProviderError(
        `Unknown model catalog provider ${JSON.stringify(params.provider)}. Run openclaw models list --all to list models and their provider IDs.`,
      );
    }
  }
  return {
    normalizeProvider,
    providerFilter,
    matchesProvider: (entry: { provider: string }) =>
      !providerFilter || normalizeProvider(entry.provider) === providerFilter,
  };
}
