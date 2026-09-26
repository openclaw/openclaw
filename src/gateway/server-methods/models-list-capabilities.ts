import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createPreparedModelCatalogProviderNormalizer } from "../../agents/model-catalog-provider-normalizer.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { projectDecisionModelCatalog } from "../../model-catalog/decision-compatibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";

type ApiKeyProviderCapabilities = {
  providers: ReadonlyMap<string, boolean>;
  resolveProvider(provider: string): string;
};
export function apiKeyProviderCapabilities(params: {
  cfg: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir: string;
}): ApiKeyProviderCapabilities {
  const { capabilities, resolveProvider } = resolveModelProviderCapabilities({
    config: params.cfg,
    metadataSnapshot: params.metadataSnapshot,
    workspaceDir: params.workspaceDir,
  });
  return {
    providers: new Map(
      capabilities.map(({ provider, apiKeySupported }) => [provider, apiKeySupported]),
    ),
    resolveProvider,
  };
}

/** The compatibility wire derives only from the normal selected catalog. */
export function listDecisionModels(params: {
  catalog: readonly ModelCatalogEntry[];
  snapshot: PluginMetadataSnapshot;
}): NonNullable<ModelsListResult["decisionModels"]> {
  return projectDecisionModelCatalog(params.catalog).flatMap((model) => {
    const owners = params.snapshot.owners.modelCatalogProviders.get(model.provider);
    const pluginId = owners?.length === 1 ? owners[0] : undefined;
    return pluginId ? [{ ...model, pluginId }] : [];
  });
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
      throw new Error(
        "Unknown model catalog provider. Use a provider id from the installed plugins or configured providers.",
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
