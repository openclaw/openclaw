/** Control-plane provider discovery helpers that keep runtime imports lazy until catalog hooks run. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import {
  copyProviderCatalogOutcomes,
  copyProviderCatalogResultProjection,
} from "./provider-catalog-result.js";
import type { ProviderCatalogContext, ProviderCatalogOutcome } from "./provider-catalog.types.js";
import type { ProviderCatalogOrder, ProviderPlugin } from "./types.js";

const DISCOVERY_ORDER: readonly ProviderCatalogOrder[] = ["simple", "profile", "paired", "late"];
const providerRuntimeLoader = createLazyImportLoader(
  () => import("./provider-discovery.runtime.js"),
);

type PreparedProviderStaticCatalogEntry = Readonly<{
  provider: ProviderPlugin;
  providerConfigs: Readonly<Record<string, ModelProviderConfig>>;
}>;

export type PreparedProviderStaticCatalog = Readonly<{
  /** Provider handles captured for this config/workspace generation. */
  providers?: readonly ProviderPlugin[];
  entries: readonly PreparedProviderStaticCatalogEntry[];
}>;

/** Options for resolving plugin providers that can contribute model catalog entries. */
export type ResolveRuntimePluginDiscoveryProvidersParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  includeManifestModelCatalogProviders?: boolean;
  includeSyntheticAuthProviders?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
};

export type ProviderDiscoveryPlan =
  | { kind: "entries"; providers: ProviderPlugin[] }
  | { kind: "runtime"; providers: ProviderPlugin[]; pluginIds: string[] | undefined };

export async function planRuntimePluginDiscovery(
  params: ResolveRuntimePluginDiscoveryProvidersParams,
): Promise<ProviderDiscoveryPlan> {
  return (await providerRuntimeLoader.load()).planPluginDiscoveryRuntime(params);
}

/** Loads provider runtime discovery and filters to providers that can produce catalog order entries. */
export async function resolveRuntimePluginDiscoveryProviders(
  params: ResolveRuntimePluginDiscoveryProvidersParams,
): Promise<ProviderPlugin[]> {
  return (await providerRuntimeLoader.load())
    .resolvePluginDiscoveryProvidersRuntime(params)
    .filter(
      (provider) =>
        (provider.catalog ?? provider.staticCatalog) ||
        (params.includeSyntheticAuthProviders === true &&
          (typeof provider.resolveSyntheticAuth === "function" ||
            typeof provider.prepareSyntheticAuth === "function")),
    );
}

/** Groups plugin providers into stable discovery phases for catalog probing. */
export function groupPluginDiscoveryProvidersByOrder(
  providers: ProviderPlugin[],
): Record<ProviderCatalogOrder, ProviderPlugin[]> {
  const grouped: Record<ProviderCatalogOrder, ProviderPlugin[]> = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  };

  for (const provider of providers) {
    const order = (provider.catalog ?? provider.staticCatalog)?.order ?? "late";
    grouped[order].push(provider);
  }

  for (const order of DISCOVERY_ORDER) {
    grouped[order].sort((a, b) => a.label.localeCompare(b.label));
  }

  return grouped;
}

/** Normalizes a plugin discovery response into safe provider-config keys. */
export function normalizePluginDiscoveryResult(params: {
  provider: ProviderPlugin;
  result:
    | { provider: ModelProviderConfig }
    | { providers: Record<string, ModelProviderConfig> }
    | null
    | undefined;
}): Record<string, ModelProviderConfig> {
  const result = params.result;
  if (!result) {
    return {};
  }

  const projection = copyProviderCatalogResultProjection(result);
  const normalized = Object.create(null) as Record<string, ModelProviderConfig>;
  const entries =
    projection.kind === "provider"
      ? [
          params.provider.id,
          ...(params.provider.aliases ?? []),
          ...(params.provider.hookAliases ?? []),
        ].map((id) => [id, projection.provider] as const)
      : projection.kind === "providers"
        ? projection.providers
        : [];
  for (const [key, value] of entries) {
    const normalizedKey = normalizeProviderId(key);
    if (!normalizedKey || isBlockedObjectKey(normalizedKey)) {
      continue;
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

export async function runProviderCatalog(params: {
  provider: ProviderPlugin;
  providerIds?: readonly string[];
  /** Captured catalog identities; the hook still receives its original provider scope. */
  normalizeProviderForScope?: (provider: string) => string;
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: ProviderCatalogContext["resolveProviderApiKey"];
  resolveProviderAuth: ProviderCatalogContext["resolveProviderAuth"];
  reportCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
  isActive?: () => boolean;
}) {
  const hook = params.provider.catalog;
  if (!hook) {
    return undefined;
  }
  const result = await hook.run({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(params.providerIds !== undefined ? { providerIds: params.providerIds } : {}),
    resolveProviderApiKey: params.resolveProviderApiKey,
    resolveProviderAuth: params.resolveProviderAuth,
  });
  if (params.isActive?.() === false) {
    return undefined;
  }
  const normalizeProvider = params.normalizeProviderForScope ?? normalizeProviderId;
  for (const outcome of copyProviderCatalogOutcomes(result)) {
    if (
      params.providerIds !== undefined &&
      !params.providerIds.some(
        (providerId) => normalizeProvider(providerId) === normalizeProvider(outcome.provider),
      )
    ) {
      continue;
    }
    params.reportCatalogOutcome?.(outcome);
  }
  return result;
}

export function runProviderStaticCatalog(params: {
  provider: ProviderPlugin;
  signal?: AbortSignal;
  providerIds?: readonly string[];
}) {
  params.signal?.throwIfAborted();
  return params.provider.staticCatalog?.run({
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.providerIds ? { providerIds: params.providerIds } : {}),
    config: {},
    env: {},
    resolveProviderApiKey: () => ({
      apiKey: undefined,
    }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      mode: "none",
      source: "none",
    }),
  });
}

/**
 * Runs sterile provider catalogs once so lifecycle owners can reuse the immutable results.
 * Providers remain attached to their plugin identity for later agent-specific scope filtering.
 */
export async function prepareProviderStaticCatalog(params: {
  providers: readonly ProviderPlugin[];
  signal?: AbortSignal;
  /** Provider ids the caller will resolve from these catalogs; absent for unscoped validation. */
  providerIds?: readonly string[];
}): Promise<PreparedProviderStaticCatalog> {
  const entries: PreparedProviderStaticCatalogEntry[] = [];
  const byOrder = groupPluginDiscoveryProvidersByOrder([...params.providers]);
  for (const order of DISCOVERY_ORDER) {
    for (const provider of byOrder[order]) {
      if (!provider.staticCatalog) {
        continue;
      }
      const result = await runProviderStaticCatalog({
        provider,
        signal: params.signal,
        providerIds: params.providerIds,
      });
      params.signal?.throwIfAborted();
      entries.push(
        Object.freeze({
          provider,
          providerConfigs: normalizePluginDiscoveryResult({ provider, result }),
        }),
      );
    }
  }
  return Object.freeze({
    providers: Object.freeze([...params.providers]),
    entries: Object.freeze(entries),
  });
}

export function resolvePreparedProviderStaticConfigs(
  prepared: PreparedProviderStaticCatalog | undefined,
): Record<string, ModelProviderConfig> {
  const providers: Record<string, ModelProviderConfig> = {};
  for (const entry of prepared?.entries ?? []) {
    Object.assign(providers, entry.providerConfigs);
  }
  return providers;
}
