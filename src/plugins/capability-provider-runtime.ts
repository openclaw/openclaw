import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import * as talk from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveVoiceModelRefs } from "../tts/voice-models.js";
import {
  getLoadedRuntimePluginRegistry,
  registryContainsRuntimePluginIds,
} from "./active-runtime-registry.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { isBundledProviderCompatContract } from "./bundled-provider-compat.js";
import type { PluginCapabilityCatalog } from "./capability-catalog.types.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { createInstalledPluginEnabledPredicate } from "./installed-plugin-index.js";
import { resolvePluginCapabilityCatalogContext } from "./loader-runtime-load.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import {
  hasManifestContractValue,
  isManifestPluginAvailableForControlPlane,
  isManifestPluginOwnerAllowedByControlPlanePolicy,
  loadManifestContractSnapshot,
} from "./manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { findCapabilityProviderEntry } from "./provider-registry-shared.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import {
  buildPluginRuntimeLoadOptions,
  getPluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "./runtime/load-context.js";

type CapabilityProviderRegistryKey =
  | "embeddingProviders"
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders"
  | "mediaUnderstandingProviders"
  | "transcriptSourceProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

export type CapabilityProviderFor<K extends CapabilityProviderRegistryKey> =
  PluginRegistry[K][number]["provider"];
type CapabilityProviderProjector<K extends CapabilityProviderRegistryKey> = (
  provider: CapabilityProviderFor<K>,
  pluginId: string,
) => CapabilityProviderFor<K>;
type SelectedCapabilityRegistry<K extends CapabilityProviderRegistryKey> = (
  registry: PluginRegistry | undefined,
) => CapabilityProviderProjector<K> | void;

function projectCapabilityProviderEntries<K extends CapabilityProviderRegistryKey>(
  entries: PluginRegistry[K],
  project: CapabilityProviderProjector<K> | void,
): PluginRegistry[K] {
  if (!project) {
    return entries;
  }
  // The projector preserves the selected capability family and every registration field.
  return entries.map((entry) => ({
    ...entry,
    provider: project(entry.provider, entry.pluginId),
  })) as PluginRegistry[K];
}

type CapabilityPluginResolution = {
  runtimePluginIds: string[];
  bundledCompatPluginIds: string[];
};

function shouldMergeManifestProvidersWhenActive(key: CapabilityProviderRegistryKey): boolean {
  return (
    key === "mediaUnderstandingProviders" ||
    key === "imageGenerationProviders" ||
    key === "videoGenerationProviders" ||
    key === "musicGenerationProviders"
  );
}

function shouldSkipCapabilityResolution(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
}): boolean {
  return params.cfg?.plugins?.enabled === false && params.key !== "speechProviders";
}

function prepareCapabilityPluginResolution(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "plugins">;
}) {
  const snapshot =
    params.pluginMetadataSnapshot ??
    loadManifestContractSnapshot({
      config: params.cfg,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  const isEnabled = createInstalledPluginEnabledPredicate(snapshot.index.plugins, params.cfg);
  let normalizedConfig: NormalizedPluginsConfig | undefined;
  return function resolve(
    key: CapabilityProviderRegistryKey,
    providerId?: string,
    providerIds?: ReadonlySet<string>,
  ): CapabilityPluginResolution {
    const matchedProviderIds = providerIds ? new Set<string>() : undefined;
    const availableContractPlugins = snapshot.plugins.filter((plugin) => {
      if (
        !hasManifestContractValue({ plugin, contract: key, value: providerId }) ||
        (providerIds && !plugin.contracts?.[key]?.some((value) => providerIds.has(value))) ||
        !isManifestPluginAvailableForControlPlane({
          snapshot,
          plugin,
          config: params.cfg,
          isInstalledPluginEnabled: isEnabled,
          normalizedConfig:
            params.cfg?.plugins &&
            (normalizedConfig ??= normalizePluginsConfig(params.cfg.plugins)),
          // Legacy TTS remains available when the operator disables plugins globally.
          allowRestrictiveAllowlistBypass:
            key === "speechProviders" && params.cfg?.plugins?.enabled === false,
          allowBundledProviderCompat: isBundledProviderCompatContract(key),
        })
      ) {
        return false;
      }
      if (providerIds && matchedProviderIds) {
        for (const value of plugin.contracts?.[key] ?? []) {
          if (providerIds.has(value)) {
            matchedProviderIds.add(value);
          }
        }
      }
      return true;
    });
    // Runtime aliases may be absent from manifests. Partial coverage needs all
    // eligible owners; zero coverage stays empty so cold catalogs remain unfiltered.
    if (providerIds && matchedProviderIds?.size && matchedProviderIds.size < providerIds.size) {
      return resolve(key, providerId);
    }
    return {
      runtimePluginIds: sortUniqueStrings(availableContractPlugins.map((plugin) => plugin.id)),
      bundledCompatPluginIds: sortUniqueStrings(
        availableContractPlugins
          .filter((plugin) => plugin.origin === "bundled")
          .map((plugin) => plugin.id),
      ),
    };
  };
}

function createCapabilityProviderLoadOptions(params: {
  cfg?: OpenClawConfig;
  resolution: CapabilityPluginResolution;
  loadContext?: PluginRuntimeLoadContext;
}): PluginLoadOptions {
  const pluginIds = params.resolution.bundledCompatPluginIds;
  const config = withBundledPluginEnablementCompat({
    config: params.cfg,
    pluginIds,
    ...(params.loadContext?.env ? { env: params.loadContext.env } : {}),
  });
  const overrides: PluginLoadOptions = {
    ...(config === undefined ? {} : { config }),
    onlyPluginIds: params.resolution.runtimePluginIds,
    activate: false,
  };
  return params.loadContext
    ? buildPluginRuntimeLoadOptions(params.loadContext, overrides)
    : overrides;
}

function resolveCapabilityLoadContext(
  registry: PluginRegistry | undefined,
  cfg: OpenClawConfig | undefined,
): PluginRuntimeLoadContext | undefined {
  const context = getPluginRuntimeLoadContext(registry);
  if (!context?.metadataSnapshot || context.env !== process.env) {
    return undefined;
  }
  // Validate the caller's original policy before speech compatibility derives an enabled config.
  // A retained request must not borrow facts from a replaced or differently scoped generation.
  return getCurrentPluginMetadataSnapshot({
    config: cfg,
    workspaceDir: context.workspaceDir,
    ...(cfg === undefined ? { requireDefaultDiscoveryContext: true } : {}),
  }) === context.metadataSnapshot
    ? context
    : undefined;
}

function mergeCapabilityProviderEntries<K extends CapabilityProviderRegistryKey>(
  left: PluginRegistry[K],
  right: PluginRegistry[K],
): PluginRegistry[K] {
  const merged = new Map<string, PluginRegistry[K][number]>();
  for (const entries of [left, right]) {
    for (const entry of entries) {
      if (!merged.has(entry.provider.id)) {
        merged.set(entry.provider.id, entry);
      }
    }
  }
  return [...merged.values()] as PluginRegistry[K];
}

function addStringValue(target: Set<string>, value: unknown): void {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized) {
    target.add(normalized);
  }
}

function collectRequestedCapabilityProviderIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  includeVoiceModel?: boolean;
}): Set<string> | undefined {
  if (
    !shouldScopeCapabilityLoadToRequestedProviders(params.key) ||
    (params.key === "realtimeTranscriptionProviders" && !params.includeVoiceModel)
  ) {
    return undefined;
  }
  const requested = new Set<string>();
  const cfg = params.cfg;
  if (params.key === "speechProviders") {
    for (const provider of [
      cfg?.tts?.provider,
      ...Object.keys(cfg?.tts?.providers ?? {}),
      cfg && talk.resolveConfiguredTalkSpeechProviderId(cfg),
    ]) {
      addStringValue(requested, provider);
    }
  }
  if (params.includeVoiceModel) {
    for (const ref of resolveVoiceModelRefs(cfg?.agents?.defaults?.voiceModel)) {
      addStringValue(requested, ref.provider);
    }
  }
  if (params.key === "speechProviders") {
    for (const provider of Object.keys(cfg?.models?.providers ?? {})) {
      addStringValue(requested, provider);
    }
  } else if (params.key === "realtimeVoiceProviders") {
    addStringValue(requested, talk.resolveConfiguredTalkRealtimeProviderId(cfg ?? {}));
    return requested.size > 0 ? requested : undefined;
  }
  return requested;
}

function shouldScopeCapabilityLoadToRequestedProviders(
  key: CapabilityProviderRegistryKey,
): key is keyof PluginCapabilityCatalog {
  return (
    key === "speechProviders" ||
    key === "realtimeTranscriptionProviders" ||
    key === "realtimeVoiceProviders"
  );
}

function* capabilityProviderIds(provider: { id: string; aliases?: unknown }) {
  yield provider.id.toLowerCase();
  if (Array.isArray(provider.aliases)) {
    for (const alias of provider.aliases) {
      if (typeof alias === "string") {
        yield alias.toLowerCase();
      }
    }
  }
}

function removeActiveProviderIds(
  requested: Set<string>,
  entries: PluginRegistry[CapabilityProviderRegistryKey],
): void {
  for (const { provider } of entries) {
    for (const id of capabilityProviderIds(provider)) {
      requested.delete(id);
    }
  }
}

function filterPolicyAllowedCapabilityProviders<K extends CapabilityProviderRegistryKey>(params: {
  entries: PluginRegistry[K];
  registry?: PluginRegistry;
  cfg?: OpenClawConfig;
  key: K;
  bundledPluginIds?: ReadonlySet<string>;
}): PluginRegistry[K] {
  if (!params.cfg?.plugins) {
    return params.entries;
  }
  let normalizedConfig: NormalizedPluginsConfig | undefined;
  const origins = new Map(
    (params.registry?.plugins ?? []).map((plugin) => [plugin.id, plugin.origin]),
  );
  return params.entries.filter((entry) => {
    const origin =
      origins.get(entry.pluginId) ??
      (params.bundledPluginIds?.has(entry.pluginId) ? "bundled" : "global");
    return isManifestPluginOwnerAllowedByControlPlanePolicy({
      plugin: { id: entry.pluginId, origin },
      config: params.cfg,
      normalizedConfig: (normalizedConfig ??= normalizePluginsConfig(params.cfg?.plugins)),
      allowRestrictiveAllowlistBypass:
        params.key === "speechProviders" && params.cfg?.plugins?.enabled === false,
      allowBundledProviderCompat: isBundledProviderCompatContract(params.key),
    });
  }) as PluginRegistry[K];
}

function prepareCapabilityProviderLoad<K extends CapabilityProviderRegistryKey>(
  params: {
    key: K;
    bundledCompatPluginIds: string[];
    loadOptions: PluginLoadOptions;
    requested?: Set<string>;
  },
  onSelectedRegistry?: SelectedCapabilityRegistry<K>,
) {
  const allowedPluginIds = new Set(params.loadOptions.onlyPluginIds);
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const loadedRegistry = scopedRegistry
    ? registryContainsRuntimePluginIds(scopedRegistry, params.loadOptions.onlyPluginIds)
      ? scopedRegistry
      : undefined
    : getLoadedRuntimePluginRegistry({
        env: params.loadOptions.env,
        loadOptions: params.loadOptions,
        workspaceDir: params.loadOptions.workspaceDir,
        requiredPluginIds: params.loadOptions.onlyPluginIds,
      });
  const loadedProject = onSelectedRegistry?.(loadedRegistry);
  const filterAllowedEntries = (registry: PluginRegistry | undefined): PluginRegistry[K] => {
    const project = registry === loadedRegistry ? loadedProject : onSelectedRegistry?.(registry);
    const entries = (registry?.[params.key] ?? []).filter((entry) =>
      allowedPluginIds.has(entry.pluginId),
    ) as PluginRegistry[K];
    return projectCapabilityProviderEntries(entries, project);
  };
  const catalogFamily = shouldScopeCapabilityLoadToRequestedProviders(params.key)
    ? params.key
    : undefined;
  return {
    loadOptions: params.loadOptions,
    loadedRegistry,
    resolveLoadOptions: () => ({
      ...params.loadOptions,
      ...(catalogFamily
        ? {
            capabilityCatalog: {
              family: catalogFamily,
              context: resolvePluginCapabilityCatalogContext(),
            },
          }
        : {}),
    }),
    merge(entries: PluginRegistry[K], registry: PluginRegistry) {
      return mergeCapabilityProviderEntries(entries, filterAllowedEntries(registry));
    },
    filterAllowedEntries,
    fallback(registry: PluginRegistry | undefined) {
      const entries = filterAllowedEntries(registry);
      const missingRequested =
        params.requested && params.requested.size > 0 ? new Set(params.requested) : undefined;
      if (missingRequested) {
        removeActiveProviderIds(missingRequested, entries);
      }
      if (entries.length > 0 && (!missingRequested || missingRequested.size === 0)) {
        return { entries, pluginIds: [] };
      }
      const bundledCompatPluginIds = params.bundledCompatPluginIds.filter(
        (pluginId) =>
          !registry?.plugins.some(
            (plugin) =>
              plugin.id === pluginId &&
              catalogFamily &&
              plugin.capabilityCatalog?.includes(catalogFamily),
          ),
      );
      return { entries, pluginIds: bundledCompatPluginIds };
    },
  };
}

function loadCapabilityProviderEntries<K extends CapabilityProviderRegistryKey>(
  load: ReturnType<typeof prepareCapabilityProviderLoad<K>>,
): PluginRegistry[K] {
  const registry = load.loadedRegistry ?? resolveRuntimePluginRegistry(load.resolveLoadOptions());
  const { entries, pluginIds } = load.fallback(registry);
  if (pluginIds.length === 0) {
    return entries;
  }
  const captured = load.filterAllowedEntries(
    loadBundledCapabilityRuntimeRegistry({
      ...load.loadOptions,
      pluginIds,
    }),
  );
  return entries.length > 0 ? mergeCapabilityProviderEntries(entries, captured) : captured;
}

export function resolvePluginCapabilityProvider<K extends CapabilityProviderRegistryKey>(
  params: { key: K; providerId: string; cfg?: OpenClawConfig },
  onSelectedRegistry?: SelectedCapabilityRegistry<K>,
): CapabilityProviderFor<K> | undefined {
  const resolution = preparePluginCapabilityProviderLookup(params, onSelectedRegistry);
  return resolution.resolve(
    resolution.load ? loadCapabilityProviderEntries(resolution.prepareLoad()) : [],
  );
}

export function preparePluginCapabilityProviderLookup<K extends CapabilityProviderRegistryKey>(
  params: { key: K; providerId: string; cfg?: OpenClawConfig },
  onSelectedRegistry?: SelectedCapabilityRegistry<K>,
) {
  if (shouldSkipCapabilityResolution(params)) {
    return { load: undefined, resolve: (_entries: PluginRegistry[K]) => undefined };
  }

  // A targeted lookup retains only the canonical/alias winner, never competing providers.
  const projections = new WeakMap<object, () => CapabilityProviderFor<K>>();
  const selectRegistry: SelectedCapabilityRegistry<K> | undefined =
    onSelectedRegistry &&
    ((registry) => {
      const project = onSelectedRegistry(registry);
      return project
        ? (provider, pluginId) => {
            projections.set(provider, () => project(provider, pluginId));
            return provider;
          }
        : undefined;
    });
  const selectProvider = (entries: PluginRegistry[K]) => {
    const provider = findCapabilityProviderEntry<PluginRegistry[K][number]>(
      entries,
      params.providerId,
    )?.provider;
    return provider ? (projections.get(provider)?.() ?? provider) : undefined;
  };

  const activeRegistry =
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getLoadedRuntimePluginRegistry();
  const project = selectRegistry?.(activeRegistry);
  const activeProviders = projectCapabilityProviderEntries(
    filterPolicyAllowedCapabilityProviders({
      entries: activeRegistry?.[params.key] ?? [],
      registry: activeRegistry,
      cfg: params.cfg,
      key: params.key,
    }),
    project,
  );
  const activeProvider = selectProvider(activeProviders);
  if (activeProvider) {
    return { load: undefined, resolve: (_entries: PluginRegistry[K]) => activeProvider };
  }

  const loadContext = resolveCapabilityLoadContext(activeRegistry, params.cfg);
  const resolvePluginIds = prepareCapabilityPluginResolution({
    cfg: params.cfg,
    pluginMetadataSnapshot: loadContext?.metadataSnapshot,
  });
  let pluginIds = resolvePluginIds(params.key, params.providerId);
  if (pluginIds.runtimePluginIds.length === 0) {
    // Manifest contracts index canonical provider ids, while runtime providers
    // may expose aliases. Fall back to the capability owners so a configured
    // alias can still resolve when its provider is absent from the active registry.
    pluginIds = resolvePluginIds(params.key);
    if (pluginIds.runtimePluginIds.length === 0) {
      return { load: undefined, resolve: (_entries: PluginRegistry[K]) => undefined };
    }
  }

  const loadOptions = createCapabilityProviderLoadOptions({
    cfg: params.cfg,
    resolution: pluginIds,
    loadContext,
  });
  const load = {
    key: params.key,
    bundledCompatPluginIds: pluginIds.bundledCompatPluginIds,
    loadOptions,
    requested: new Set([params.providerId.toLowerCase()]),
  };
  return {
    load,
    prepareLoad: () => prepareCapabilityProviderLoad(load, selectRegistry),
    resolve: selectProvider,
  };
}

export function preparePluginCapabilityProviderResolution<K extends CapabilityProviderRegistryKey>(
  params: {
    key: K;
    cfg?: OpenClawConfig;
    additionalProviderIds?: readonly string[];
  },
  onSelectedRegistry?: SelectedCapabilityRegistry<K>,
) {
  if (shouldSkipCapabilityResolution(params)) {
    return {
      load: undefined,
      resolve: (_entries: PluginRegistry[K]): CapabilityProviderFor<K>[] => [],
    };
  }

  const activeRegistry =
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getLoadedRuntimePluginRegistry();
  const project = onSelectedRegistry?.(activeRegistry);
  const activeProviders = projectCapabilityProviderEntries(
    filterPolicyAllowedCapabilityProviders({
      entries: activeRegistry?.[params.key] ?? [],
      registry: activeRegistry,
      cfg: params.cfg,
      key: params.key,
    }),
    project,
  );
  const requested =
    collectRequestedCapabilityProviderIds({
      key: params.key,
      cfg: params.cfg,
      includeVoiceModel: activeProviders.length > 0,
    }) ?? new Set<string>();
  const mergeManifestProviders = shouldMergeManifestProvidersWhenActive(params.key);
  // Media/generation catalogs include every eligible owner; their execution owners
  // select models later. Additional ids must not narrow an unscoped catalog.
  if (requested.size > 0 || (activeProviders.length > 0 && !mergeManifestProviders)) {
    for (const providerId of params.additionalProviderIds ?? []) {
      addStringValue(requested, providerId);
    }
  }
  removeActiveProviderIds(requested, activeProviders);
  const requestedProviders = requested.size > 0 ? requested : undefined;
  if (activeProviders.length > 0 && !requestedProviders && !mergeManifestProviders) {
    return {
      load: undefined,
      resolve: (_entries: PluginRegistry[K]) =>
        activeProviders.map((entry) => entry.provider) as CapabilityProviderFor<K>[],
    };
  }
  const requestedProviderLoadScope =
    requestedProviders && shouldScopeCapabilityLoadToRequestedProviders(params.key)
      ? requestedProviders
      : undefined;
  const loadContext = resolveCapabilityLoadContext(activeRegistry, params.cfg);
  const resolvePluginIds = prepareCapabilityPluginResolution({
    cfg: params.cfg,
    pluginMetadataSnapshot: loadContext?.metadataSnapshot,
  });
  const requestedPluginIds = requestedProviderLoadScope
    ? resolvePluginIds(params.key, undefined, requestedProviderLoadScope)
    : undefined;
  const requestedProviderFilter =
    requestedProviders &&
    (!shouldScopeCapabilityLoadToRequestedProviders(params.key) ||
      requestedPluginIds?.runtimePluginIds.length)
      ? requestedProviders
      : undefined;
  const pluginIds = requestedPluginIds?.runtimePluginIds.length
    ? requestedPluginIds
    : resolvePluginIds(params.key);
  const loadOptions = createCapabilityProviderLoadOptions({
    cfg: params.cfg,
    resolution: pluginIds,
    loadContext,
  });
  const load = {
    key: params.key,
    bundledCompatPluginIds: pluginIds.bundledCompatPluginIds,
    loadOptions,
    requested: requestedProviderFilter,
  };
  return {
    load,
    prepareLoad: () => prepareCapabilityProviderLoad(load, onSelectedRegistry),
    resolve: (loadedProviders: PluginRegistry[K]): CapabilityProviderFor<K>[] => {
      const loadedProviderFilter =
        activeProviders.length > 0 ? requestedProviders : requestedProviderFilter;
      const requestedLoadedProviders = loadedProviderFilter
        ? (loadedProviders.filter(({ provider }) => {
            for (const id of capabilityProviderIds(provider)) {
              if (loadedProviderFilter.has(id)) {
                return true;
              }
            }
            return false;
          }) as PluginRegistry[K])
        : loadedProviders;
      return mergeCapabilityProviderEntries(activeProviders, requestedLoadedProviders).map(
        (entry) => entry.provider as CapabilityProviderFor<K>,
      );
    },
  };
}

export function resolvePluginCapabilityProviders<K extends CapabilityProviderRegistryKey>(
  params: { key: K; cfg?: OpenClawConfig; additionalProviderIds?: readonly string[] },
  onSelectedRegistry?: SelectedCapabilityRegistry<K>,
): CapabilityProviderFor<K>[] {
  const resolution = preparePluginCapabilityProviderResolution(params, onSelectedRegistry);
  return resolution.resolve(
    resolution.load ? loadCapabilityProviderEntries(resolution.prepareLoad()) : [],
  );
}

export function prepareMediaCapabilityProviders(params: {
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  registry?: PluginRegistry;
}) {
  const resolvePluginIds = prepareCapabilityPluginResolution(params);
  const providers = <K extends CapabilityProviderRegistryKey>(
    key: K,
  ): readonly CapabilityProviderFor<K>[] | undefined => {
    if (shouldSkipCapabilityResolution({ key, cfg: params.cfg })) {
      return [];
    }
    const resolution = resolvePluginIds(key);
    const requiredPluginIds = resolution.runtimePluginIds;
    if (
      requiredPluginIds.length === 0 &&
      params.pluginMetadataSnapshot.plugins.some((plugin) =>
        hasManifestContractValue({
          plugin,
          contract: key,
        }),
      )
    ) {
      return Object.freeze([]);
    }
    if (!params.registry || !registryContainsRuntimePluginIds(params.registry, requiredPluginIds)) {
      return undefined;
    }
    const eligiblePluginIds = new Set(requiredPluginIds);
    const availableEntries = filterPolicyAllowedCapabilityProviders({
      entries: params.registry[key],
      registry: params.registry,
      cfg: params.cfg,
      key,
      bundledPluginIds: new Set(resolution.bundledCompatPluginIds),
    });
    if (availableEntries.some((entry) => !eligiblePluginIds.has(entry.pluginId))) {
      return undefined;
    }
    return Object.freeze(
      availableEntries.map((entry) => entry.provider),
    ) as readonly CapabilityProviderFor<K>[];
  };
  return Object.freeze({
    mediaUnderstandingProviders: providers("mediaUnderstandingProviders"),
    imageGenerationProviders: providers("imageGenerationProviders"),
    videoGenerationProviders: providers("videoGenerationProviders"),
    musicGenerationProviders: providers("musicGenerationProviders"),
  });
}
