// Resolves model suppression metadata declared by plugin manifests.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  findConfiguredProviderModel,
  projectModelProviderConfig,
} from "../config/model-provider-config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  planManifestModelCatalogSuppressions,
  type ManifestModelCatalogSuppressionEntry,
} from "../model-catalog/index.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "./manifest-contract-eligibility.js";
import type { ManifestModelSuppressionResolver } from "./manifest-model-suppression.types.js";
import { getPluginMetadataSnapshotCache } from "./plugin-cache.js";
import {
  matchesPluginProviderEndpoint,
  normalizePluginProviderBaseUrl,
} from "./plugin-metadata-provider-facts.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

type PreparedManifestSuppression = {
  entry: ManifestModelCatalogSuppressionEntry;
  allowedApis: ReadonlySet<string> | undefined;
  allowedHosts: ReadonlySet<string> | undefined;
  nativeHosts: ReadonlySet<string> | undefined;
};

function listManifestModelCatalogSuppressions(params: {
  config?: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
}) {
  const snapshot = params.snapshot;
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  const registry = {
    diagnostics: snapshot.diagnostics,
    plugins: snapshot.plugins.filter((plugin) =>
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
        normalizedConfig,
      }),
    ),
  };
  const planned = planManifestModelCatalogSuppressions({ registry });
  return { plugins: registry.plugins, suppressions: planned.suppressions };
}

function prepareNativeCatalogOwners(plugins: PluginMetadataSnapshot["plugins"]) {
  const owners = new Map<string, { pluginId: string; provider: string; native: boolean } | null>();
  for (const plugin of plugins) {
    for (const [provider, catalog] of Object.entries(plugin.modelCatalog?.providers ?? {})) {
      const normalizedBaseUrl = catalog.baseUrl && normalizePluginProviderBaseUrl(catalog.baseUrl);
      if (!normalizedBaseUrl) {
        continue;
      }
      const host = normalizeSuppressionHost(new URL(normalizedBaseUrl).hostname);
      const owner = {
        pluginId: plugin.id,
        provider: normalizeLowercaseStringOrEmpty(provider),
        native: (plugin.providerEndpoints ?? []).some(
          (endpoint) =>
            endpoint.endpointClass !== "custom" &&
            endpoint.endpointClass !== "local" &&
            matchesPluginProviderEndpoint(endpoint, { host, normalizedBaseUrl }),
        ),
      };
      const previous = owners.get(host);
      if (previous === undefined) {
        owners.set(host, owner);
      } else if (
        previous &&
        previous.pluginId === owner.pluginId &&
        previous.provider === owner.provider
      ) {
        owners.set(host, { ...owner, native: previous.native || owner.native });
      } else {
        owners.set(host, null);
      }
    }
  }
  return owners;
}

function buildManifestSuppressionError(params: {
  provider: string;
  modelId: string;
  reason?: string;
}): string {
  const ref = `${params.provider}/${params.modelId}`;
  return params.reason ? `Unknown model: ${ref}. ${params.reason}` : `Unknown model: ${ref}.`;
}

function normalizeBaseUrlHost(baseUrl: string | null | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return normalizeSuppressionHost(new URL(trimmed).hostname);
  } catch {
    return "";
  }
}

function normalizeSuppressionHost(host: string): string {
  return normalizeLowercaseStringOrEmpty(host).replace(/\.+$/, "");
}

function resolveConfiguredProviderValue(params: {
  provider: string;
  config?: OpenClawConfig;
}): ModelProviderConfig | undefined {
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  for (const [providerId, entry] of Object.entries(providers)) {
    if (normalizeLowercaseStringOrEmpty(providerId) !== params.provider) {
      continue;
    }
    return entry;
  }
  return undefined;
}

function manifestSuppressionMatchesConditions(params: {
  suppression: PreparedManifestSuppression;
  provider: string;
  baseUrl?: string | null;
  api?: ModelProviderConfig["api"];
  config?: OpenClawConfig;
}): boolean {
  const { entry, allowedApis, allowedHosts } = params.suppression;
  const when = entry.when;
  if (!when) {
    return true;
  }
  // Retirement repairs durable model choices. A missing route is unknown, even
  // when the provider's default endpoint is known; never retire a sibling auth route.
  if (entry.retirement && allowedHosts && !params.baseUrl) {
    return false;
  }
  const configuredProvider = resolveConfiguredProviderValue({
    provider: params.provider,
    config: params.config,
  });
  if (allowedApis) {
    const effectiveApi =
      params.api !== undefined
        ? normalizeLowercaseStringOrEmpty(params.api)
        : configuredProvider
          ? normalizeLowercaseStringOrEmpty(configuredProvider.api)
          : params.provider;
    if (!effectiveApi || !allowedApis.has(effectiveApi)) {
      return false;
    }
  }
  if (allowedHosts) {
    const baseUrlHost = normalizeBaseUrlHost(params.baseUrl ?? configuredProvider?.baseUrl);
    if (!baseUrlHost && !params.baseUrl && !configuredProvider?.baseUrl) {
      return true;
    }
    if (!baseUrlHost) {
      return false;
    }
    if (!allowedHosts.has(baseUrlHost)) {
      return false;
    }
  }
  return true;
}

export function buildManifestBuiltInModelSuppressionResolver(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): ManifestModelSuppressionResolver {
  const snapshot = params.metadataSnapshot ?? loadManifestMetadataSnapshot(params);
  const cache = getPluginMetadataSnapshotCache(snapshot).metadata.modelSuppressionResolvers;
  let compiled = cache.get(snapshot);
  if (!compiled) {
    compiled = { byConfig: new WeakMap() };
    cache.set(snapshot, compiled);
  }
  const cached = params.config ? compiled.byConfig.get(params.config) : compiled.unconfigured;
  if (cached) {
    return cached;
  }
  const plan = listManifestModelCatalogSuppressions({ snapshot, config: params.config });
  const declaredProviders = new Set(
    plan.plugins.flatMap((plugin) =>
      [
        ...(plugin.providers ?? []),
        ...Object.keys(plugin.modelCatalog?.providers ?? {}),
        ...Object.keys(plugin.modelCatalog?.aliases ?? {}),
      ].map(normalizeLowercaseStringOrEmpty),
    ),
  );
  const nativeOwners = prepareNativeCatalogOwners(plan.plugins);
  const suppressions = new Map<string, PreparedManifestSuppression[]>();
  for (const entry of plan.suppressions) {
    const allowedHosts = entry.when?.baseUrlHosts?.length
      ? new Set(entry.when.baseUrlHosts.map(normalizeSuppressionHost))
      : undefined;
    const prepared: PreparedManifestSuppression = {
      entry,
      allowedApis: entry.when?.providerConfigApiIn?.length
        ? new Set(entry.when.providerConfigApiIn.map(normalizeLowercaseStringOrEmpty))
        : undefined,
      allowedHosts,
      nativeHosts:
        entry.retirement && allowedHosts
          ? new Set(
              [...allowedHosts].filter((host) => {
                const owner = nativeOwners.get(host);
                return (
                  owner?.native &&
                  owner.pluginId === entry.pluginId &&
                  owner.provider === entry.provider
                );
              }),
            )
          : undefined,
    };
    // Preserve planner order when a route condition skips an earlier same-model rule.
    const rules = suppressions.get(entry.model);
    if (rules) {
      rules.push(prepared);
    } else {
      suppressions.set(entry.model, [prepared]);
    }
  }

  const physicalRetirement = (
    provider: string,
    id: string,
    baseUrl: string | null | undefined,
    config: OpenClawConfig | undefined,
    api?: ModelProviderConfig["api"],
  ) => {
    if (!baseUrl || declaredProviders.has(provider)) {
      return undefined;
    }
    const host = normalizeBaseUrlHost(baseUrl);
    return suppressions.get(id)?.find(
      (prepared) =>
        prepared.nativeHosts?.has(host) &&
        manifestSuppressionMatchesConditions({
          suppression: prepared,
          provider,
          baseUrl,
          config,
          api,
        }),
    );
  };
  const resolve = (
    input: Parameters<ManifestModelSuppressionResolver>[0],
  ): ReturnType<ManifestModelSuppressionResolver> => {
    const provider = normalizeLowercaseStringOrEmpty(input.provider);
    const modelId = normalizeLowercaseStringOrEmpty(input.id);
    if (!provider || !modelId) {
      return undefined;
    }
    const candidates = suppressions.get(modelId);
    if (!candidates) {
      return undefined;
    }
    const matches = (prepared: PreparedManifestSuppression) =>
      (!input.unconditionalOnly || !prepared.entry.when) &&
      manifestSuppressionMatchesConditions({
        suppression: prepared,
        provider,
        baseUrl: input.baseUrl,
        config: params.config,
        api: input.api,
      });
    const direct = candidates.find(
      (prepared) => prepared.entry.provider === provider && matches(prepared),
    );
    // Endpoint policy does not transfer the logical provider or its account ownership.
    const physical =
      !direct && !input.unconditionalOnly
        ? physicalRetirement(provider, modelId, input.baseUrl, params.config, input.api)
        : undefined;
    const suppression = (direct ?? physical)?.entry;
    if (!suppression) {
      return undefined;
    }
    return {
      suppress: true,
      errorMessage: buildManifestSuppressionError({
        provider,
        modelId,
        reason: suppression.retirement
          ? `${suppression.reason ?? "This model has retired."} Run \`openclaw doctor --fix\` to ${suppression.retirement.replacedBy ? `replace it with ${suppression.retirement.replacedBy}` : "clear the retired override and use the default model"}.`
          : suppression.reason,
      }),
      ...(suppression.retirement ? { retirement: suppression.retirement } : {}),
    };
  };
  const resolver: ManifestModelSuppressionResolver = Object.assign(resolve, {
    hasRetirementCandidate(input: { provider?: string | null; id?: string | null }) {
      const provider = normalizeLowercaseStringOrEmpty(input.provider);
      const id = normalizeLowercaseStringOrEmpty(input.id);
      const candidates = suppressions.get(id);
      if (!candidates) {
        return false;
      }
      if (candidates.some((rule) => rule.entry.provider === provider && rule.entry.retirement)) {
        return true;
      }
      if (declaredProviders.has(provider)) {
        return false;
      }
      const configured = resolveConfiguredProviderValue({ provider, config: params.config });
      const model = findConfiguredProviderModel(
        configured,
        provider,
        id,
        normalizeLowercaseStringOrEmpty,
      );
      const baseUrl = model?.baseUrl ?? configured?.baseUrl;
      if (!baseUrl) {
        return false;
      }
      const config = projectModelProviderConfig(params.config, provider, {
        api: model?.api ?? configured?.api,
        baseUrl,
      });
      return Boolean(physicalRetirement(provider, id, baseUrl, config));
    },
  });
  if (params.config) {
    compiled.byConfig.set(params.config, resolver);
  } else {
    compiled.unconfigured = resolver;
  }
  return resolver;
}
