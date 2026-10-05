import { normalizeModelCatalogProviderRows } from "@openclaw/model-catalog-core/model-catalog-normalize";
import {
  buildModelCatalogMergeKey,
  normalizeModelCatalogProviderId,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import type {
  ModelCatalog,
  ModelCatalogDiscovery,
  ModelCatalogModel,
  ModelCatalogProvider,
  NormalizedModelCatalogRow,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeUniqueStringEntries } from "../../packages/normalization-core/src/string-normalization.js";

type ManifestModelCatalogPlugin = {
  providerEndpoints?: readonly import("../plugins/manifest-types.js").PluginManifestProviderEndpoint[];
  id: string;
  providers?: readonly string[];
  modelCatalog?: Pick<
    ModelCatalog,
    "providers" | "aliases" | "suppressions" | "discovery" | "runtimeAugment"
  >;
};

type ManifestModelCatalogRegistry = {
  plugins: readonly ManifestModelCatalogPlugin[];
};

type ManifestModelCatalogPlanEntry = {
  pluginId: string;
  provider: string;
  discovery?: ModelCatalogDiscovery;
  rows: readonly NormalizedModelCatalogRow[];
};

type ManifestModelCatalogConflict = {
  mergeKey: string;
  ref: string;
  provider: string;
  modelId: string;
  firstPluginId: string;
  secondPluginId: string;
};

type ManifestModelCatalogPlan = {
  rows: readonly NormalizedModelCatalogRow[];
  entries: readonly ManifestModelCatalogPlanEntry[];
  conflicts: readonly ManifestModelCatalogConflict[];
};

export type ManifestModelCatalogRowSelection = "static" | "supplemental";

export type ManifestModelCatalogSuppressionEntry = {
  pluginId: string;
  provider: string;
  model: string;
  mergeKey: string;
  reason?: string;
  retirement?: NonNullable<ModelCatalog["suppressions"]>[number]["retirement"];
  when?: NonNullable<ModelCatalog["suppressions"]>[number]["when"];
};

type ManifestModelCatalogSuppressionPlan = {
  suppressions: readonly ManifestModelCatalogSuppressionEntry[];
};

function mergeRemoteModelWithTrustedTransport(
  remoteModel: ModelCatalogModel,
  trustedModel: ModelCatalogModel | undefined,
): ModelCatalogModel {
  // Spread keeps an untrusted own `__proto__` key as data instead of invoking
  // Object.prototype's setter while trusted transport fields win explicitly.
  return {
    ...remoteModel,
    ...(trustedModel?.baseUrl ? { baseUrl: trustedModel.baseUrl } : {}),
    ...(trustedModel?.headers ? { headers: trustedModel.headers } : {}),
  };
}

export function planManifestModelCatalogRows(params: {
  registry: ManifestModelCatalogRegistry;
  providerFilter?: string;
  providerFilters?: readonly string[];
  mergeKeyFilter?: ReadonlySet<string>;
  remoteOverlay?: Readonly<Record<string, ModelCatalogProvider>>;
  resolveRemoteProvider?: (provider: string) => ModelCatalogProvider | undefined;
  includeProvider?: (provider: string, plugin: ManifestModelCatalogPlugin) => boolean;
  selection?: ManifestModelCatalogRowSelection;
}): ManifestModelCatalogPlan {
  const hasProviderFilter = Boolean(params.providerFilter) || params.providerFilters !== undefined;
  const providerFilters = hasProviderFilter
    ? new Set(
        normalizeUniqueStringEntries(
          [
            ...(params.providerFilter !== undefined ? [params.providerFilter] : []),
            ...(params.providerFilters ?? []),
          ].map(normalizeModelCatalogProviderId),
        ),
      )
    : undefined;
  const entries: ManifestModelCatalogPlanEntry[] = [];

  for (const plugin of params.registry.plugins) {
    const providers = plugin.modelCatalog?.providers;
    if (!providers) {
      continue;
    }
    const aliasesByTargetProvider = buildModelCatalogProviderAliasTargets(plugin);

    for (const [provider, providerCatalog] of Object.entries(providers)) {
      const normalizedProvider = normalizeModelCatalogProviderId(provider);
      if (!normalizedProvider) {
        continue;
      }
      const providerAliases = aliasesByTargetProvider.get(normalizedProvider) ?? [];
      const plannedProviders = providerFilters
        ? normalizeUniqueStringEntries([normalizedProvider, ...providerAliases]).filter(
            (candidateProvider) => providerFilters.has(candidateProvider),
          )
        : [normalizedProvider];
      if (plannedProviders.length === 0) {
        continue;
      }
      const remoteProvider = params.resolveRemoteProvider
        ? params.resolveRemoteProvider(normalizedProvider)
        : params.remoteOverlay?.[normalizedProvider];
      for (const plannedProvider of plannedProviders) {
        if (params.includeProvider?.(plannedProvider, plugin) === false) {
          continue;
        }
        const mergeKeyFilter = params.mergeKeyFilter;
        const selectModels = (models: ModelCatalogModel[]) =>
          mergeKeyFilter
            ? models.filter((model) =>
                mergeKeyFilter.has(buildModelCatalogMergeKey(plannedProvider, model.id)),
              )
            : models;
        const manifestModels = selectModels(providerCatalog.models);
        const remoteModels = remoteProvider ? selectModels(remoteProvider.models) : [];
        const remoteModelIds = remoteModels.length
          ? new Set(remoteModels.map((model) => model.id))
          : undefined;
        const providerDefaults = remoteProvider
          ? {
              ...providerCatalog,
              ...remoteProvider,
              ...(providerCatalog.baseUrl ? { baseUrl: providerCatalog.baseUrl } : {}),
              ...(providerCatalog.headers ? { headers: providerCatalog.headers } : {}),
            }
          : providerCatalog;
        let rows = normalizeModelCatalogProviderRows({
          provider: plannedProvider,
          providerCatalog: {
            ...providerDefaults,
            models: remoteModelIds
              ? manifestModels.filter((model) => !remoteModelIds.has(model.id))
              : manifestModels,
          },
          source: "manifest",
        });
        if (remoteModels.length > 0) {
          const manifestModelsById = new Map(manifestModels.map((model) => [model.id, model]));
          rows = rows.concat(
            normalizeModelCatalogProviderRows({
              provider: plannedProvider,
              providerCatalog: {
                ...providerDefaults,
                models: remoteModels.map((model) =>
                  mergeRemoteModelWithTrustedTransport(model, manifestModelsById.get(model.id)),
                ),
              },
              source: "runtime-refresh",
            }),
          );
          // Both normalizers return owned sorted arrays; only a real overlay needs merging.
          rows.sort(
            (left, right) =>
              left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
          );
        }
        if (rows.length === 0) {
          continue;
        }
        const alias = plugin.modelCatalog?.aliases?.[plannedProvider];
        entries.push({
          pluginId: plugin.id,
          provider: plannedProvider,
          discovery: plugin.modelCatalog?.discovery?.[normalizedProvider],
          rows: alias
            ? rows.map((row) => ({
                ...row,
                ...(alias.api ? { api: alias.api } : {}),
                ...(alias.baseUrl ? { baseUrl: alias.baseUrl } : {}),
              }))
            : rows,
        });
      }
    }
  }

  const seenRows = new Map<
    string,
    {
      pluginId: string;
      row: NormalizedModelCatalogRow;
      discovery: ModelCatalogDiscovery | undefined;
    }
  >();
  const conflicts = new Map<string, ManifestModelCatalogConflict>();
  for (const entry of entries) {
    for (const row of entry.rows) {
      const seen = seenRows.get(row.mergeKey);
      if (seen) {
        // Conflicting plugin-owned declarations are dropped entirely so no
        // plugin silently wins another plugin's model ref in the merged catalog.
        if (!conflicts.has(row.mergeKey)) {
          conflicts.set(row.mergeKey, {
            mergeKey: row.mergeKey,
            ref: seen.row.ref,
            provider: seen.row.provider,
            modelId: seen.row.id,
            firstPluginId: seen.pluginId,
            secondPluginId: entry.pluginId,
          });
        }
        continue;
      }
      seenRows.set(row.mergeKey, {
        pluginId: entry.pluginId,
        row,
        discovery: entry.discovery,
      });
    }
  }

  const rows: NormalizedModelCatalogRow[] = [];
  for (const { row, discovery } of seenRows.values()) {
    if (
      conflicts.has(row.mergeKey) ||
      (params.selection === "static"
        ? discovery !== "static"
        : params.selection === "supplemental" &&
          discovery === "runtime" &&
          row.source !== "runtime-refresh")
    ) {
      continue;
    }
    rows.push(row);
  }

  rows.sort(
    (left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
  );
  return {
    entries,
    conflicts: [...conflicts.values()],
    rows,
  };
}

function buildOwnedProviderSet(plugin: ManifestModelCatalogPlugin): ReadonlySet<string> {
  return new Set(
    normalizeUniqueStringEntries((plugin.providers ?? []).map(normalizeModelCatalogProviderId)),
  );
}

export function buildModelCatalogProviderAliasTargets(
  plugin: ManifestModelCatalogPlugin,
): ReadonlyMap<string, readonly string[]> {
  const ownedProviders = buildOwnedProviderSet(plugin);
  const aliasesByTargetProvider = new Map<string, string[]>();
  for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
    const aliasProvider = normalizeModelCatalogProviderId(rawAlias);
    const targetProvider = normalizeModelCatalogProviderId(alias.provider);
    // Aliases are honored only when they point at a provider this plugin owns.
    if (!aliasProvider || !targetProvider || !ownedProviders.has(targetProvider)) {
      continue;
    }
    const aliases = aliasesByTargetProvider.get(targetProvider) ?? [];
    aliases.push(aliasProvider);
    aliasesByTargetProvider.set(targetProvider, aliases);
  }
  return aliasesByTargetProvider;
}

function buildModelCatalogProviderRefs(plugin: ManifestModelCatalogPlugin): ReadonlySet<string> {
  const refs = new Set(buildOwnedProviderSet(plugin));
  for (const aliases of buildModelCatalogProviderAliasTargets(plugin).values()) {
    for (const alias of aliases) {
      refs.add(alias);
    }
  }
  return refs;
}

export function planManifestModelCatalogSuppressions(params: {
  registry: ManifestModelCatalogRegistry;
  providerFilter?: string;
  modelFilter?: string;
}): ManifestModelCatalogSuppressionPlan {
  const providerFilter = params.providerFilter
    ? normalizeModelCatalogProviderId(params.providerFilter)
    : undefined;
  const modelFilter = params.modelFilter
    ? normalizeLowercaseStringOrEmpty(params.modelFilter)
    : undefined;
  const suppressions: ManifestModelCatalogSuppressionEntry[] = [];
  for (const plugin of params.registry.plugins) {
    let providerRefs: ReadonlySet<string> | undefined;
    for (const suppression of plugin.modelCatalog?.suppressions ?? []) {
      const provider = normalizeModelCatalogProviderId(suppression.provider);
      const model = normalizeLowercaseStringOrEmpty(suppression.model);
      if (!provider || !model) {
        continue;
      }
      if (providerFilter && provider !== providerFilter) {
        continue;
      }
      if (modelFilter && model !== modelFilter) {
        continue;
      }
      // Suppressions can affect owned providers and their declared aliases only;
      // otherwise one plugin could hide another plugin's catalog entries.
      providerRefs ??= buildModelCatalogProviderRefs(plugin);
      if (!providerRefs.has(provider)) {
        continue;
      }
      suppressions.push({
        pluginId: plugin.id,
        provider,
        model,
        mergeKey: buildModelCatalogMergeKey(provider, model),
        ...(suppression.reason ? { reason: suppression.reason } : {}),
        ...(suppression.retirement ? { retirement: suppression.retirement } : {}),
        ...(suppression.when ? { when: suppression.when } : {}),
      });
    }
  }
  suppressions.sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.model.localeCompare(right.model) ||
      left.pluginId.localeCompare(right.pluginId),
  );
  return { suppressions };
}
