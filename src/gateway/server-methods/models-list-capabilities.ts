import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createPreparedModelCatalogProviderNormalizer } from "../../agents/model-catalog-provider-normalizer.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginCredentialDescriptors } from "../../plugins/credential-descriptors.js";
import { listAvailableManifestContractPlugins } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getPath } from "../../secrets/path-utils.js";
import { parseConcreteConfigPathTokens } from "../../shared/dot-path.js";
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

export function listDecisionModels({
  config,
  snapshot,
  registry,
}: {
  config: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
  registry?: PluginRegistry;
}) {
  const decisionModels: NonNullable<ModelsListResult["decisionModels"]> = [];
  if (config.plugins?.enabled !== false) {
    const seen = new Set<string>();
    for (const plugin of listAvailableManifestContractPlugins({
      snapshot,
      config,
      contract: "decisionProviders",
    })) {
      const credentials = resolvePluginCredentialDescriptors(plugin);
      for (const model of plugin.decisionModels ?? []) {
        const key = `${model.provider}/${model.id}`;
        if (!seen.has(key)) {
          const read = (path: string) => {
            const value = getPath(
              config.plugins?.entries?.[plugin.id]?.config,
              parseConcreteConfigPathTokens(path).map(String),
            );
            return typeof value === "string"
              ? value.trim().length > 0
              : value !== undefined && value !== null && value !== false;
          };
          const setup = model.setup?.find(
            (alternative) => !alternative.whenConfigured || read(alternative.whenConfigured),
          );
          const host = registry?.decisionProviders.find(
            (entry) => entry.pluginId === plugin.id && entry.host.provider.id === model.provider,
          )?.host;
          const credential = credentials.find(
            (field) =>
              field.storage === "protected" &&
              field.path.slice(4).join(".") === setup?.credentialPath,
          );
          // Unknown local preparation is not readiness. Neither inventory nor setup invokes inference.
          let readiness: NonNullable<ModelsListResult["decisionModels"]>[number]["readiness"] =
            "unknown";
          if (setup?.kind === "api-key" || setup?.configuredPath) {
            readiness = "setup-required";
            if (setup.kind === "api-key" || (setup.configuredPath && read(setup.configuredPath))) {
              try {
                readiness = host?.inspectSetup(config) ?? "setup-required";
              } catch {
                // A broken provider hook must not hide healthy providers or claim readiness.
              }
            }
          }
          decisionModels.push({
            provider: model.provider,
            id: model.id,
            name: model.name,
            pluginId: plugin.id,
            ...(model.capabilities ? { capabilities: model.capabilities } : {}),
            ...(setup
              ? {
                  readiness,
                  setup: {
                    kind: setup.kind,
                    label: setup.label,
                    help: setup.help,
                    ...(setup.documentationUrl ? { documentationUrl: setup.documentationUrl } : {}),
                    ...(credential ? { credentialPath: credential.path } : {}),
                  },
                }
              : {}),
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
