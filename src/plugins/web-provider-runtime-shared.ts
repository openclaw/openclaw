import { withActivatedPluginIds } from "./activation-context.js";
import {
  getLoadedRuntimePluginRegistry,
  registryContainsRuntimePluginIds,
} from "./active-runtime-registry.js";
import { normalizePluginId } from "./config-state.js";
import { isPluginRegistryLoadInFlight, loadOpenClawPlugins } from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { hasCompletedPluginRuntimeRegistration } from "./plugin-runtime-artifact-binding.js";
import { hasExplicitPluginIdScope, normalizePluginIdScope } from "./plugin-scope.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-state.js";
import {
  buildPluginRuntimeLoadOptions,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";
import { getCurrentPluginToolInspection, samePluginToolSource } from "./tool-inspection-state.js";

export type ResolvePluginWebProvidersParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
  sandboxed?: boolean;
  manifestRecords?: readonly PluginManifestRecord[];
};

export type ResolveRuntimeWebProvidersParams = Omit<
  ResolvePluginWebProvidersParams,
  "mode" | "sandboxed"
>;

export type WebProviderRuntimeResolution<TEntry> = {
  resolveBundledResolutionConfig: (
    params: Pick<
      ResolvePluginWebProvidersParams,
      "config" | "workspaceDir" | "env" | "manifestRecords"
    >,
  ) => {
    config: PluginLoadOptions["config"];
    activationSourceConfig?: PluginLoadOptions["config"];
    autoEnabledReasons: Record<string, string[]>;
    manifestRecords?: readonly PluginManifestRecord[];
  };
  resolveCandidatePluginIds: (
    params: Omit<ResolvePluginWebProvidersParams, "mode">,
  ) => string[] | undefined;
  mapRegistryProviders: (params: {
    registry: PluginRegistry;
    onlyPluginIds?: readonly string[];
  }) => TEntry[];
  resolveBundledPublicArtifactProviders?: (
    params: Pick<
      ResolvePluginWebProvidersParams,
      "config" | "workspaceDir" | "env" | "onlyPluginIds" | "manifestRecords"
    >,
  ) => TEntry[] | null;
  resolveBundledRuntimeArtifactProviders?: (
    params: Pick<
      ResolvePluginWebProvidersParams,
      "config" | "workspaceDir" | "env" | "manifestRecords"
    > & { onlyPluginIds: readonly string[] },
  ) => TEntry[] | null;
};

function mergeInspectedProviderEntries<T extends { pluginId: string; provider: { id: string } }>(
  manifests: readonly PluginManifestRecord[],
  retainedPluginIds: ReadonlySet<string>,
  inspected: readonly T[],
  supplemental: readonly T[],
): T[] {
  const order = new Map(manifests.map((manifest, index) => [manifest.id, index]));
  const providers = [
    ...inspected.filter((entry) => retainedPluginIds.has(entry.pluginId)),
    ...supplemental,
  ].toSorted(
    (left, right) =>
      (order.get(left.pluginId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.pluginId) ?? Number.MAX_SAFE_INTEGER),
  );
  const ids = new Set<string>();
  return providers.filter(({ provider }) => {
    if (ids.has(provider.id.trim())) {
      return false;
    }
    ids.add(provider.id);
    return true;
  });
}

/** Resolves plugin web providers from setup, active runtime, or a scoped load. */
export function resolvePluginWebProviders<TEntry>(
  params: ResolvePluginWebProvidersParams,
  deps: WebProviderRuntimeResolution<TEntry>,
): TEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  if (params.mode === "setup") {
    const pluginIds =
      deps.resolveCandidatePluginIds({
        config: params.config,
        workspaceDir,
        env,
        onlyPluginIds: params.onlyPluginIds,
        origin: params.origin,
        sandboxed: params.sandboxed,
        ...(params.manifestRecords ? { manifestRecords: params.manifestRecords } : {}),
      }) ?? [];
    if (pluginIds.length === 0) {
      return [];
    }
    const bundledArtifactProviders = deps.resolveBundledPublicArtifactProviders?.({
      config: params.config,
      workspaceDir,
      env,
      onlyPluginIds: pluginIds,
      ...(params.manifestRecords ? { manifestRecords: params.manifestRecords } : {}),
    });
    if (bundledArtifactProviders) {
      return bundledArtifactProviders;
    }
    const registry = loadOpenClawPlugins(
      buildPluginRuntimeLoadOptions(
        {
          config: withActivatedPluginIds({
            config: params.config,
            pluginIds,
          }),
          activationSourceConfig: params.config,
          autoEnabledReasons: {},
          workspaceDir,
          env,
          logger: createPluginRuntimeLoaderLogger(),
          ...(params.manifestRecords
            ? { manifestRegistry: { plugins: [...params.manifestRecords], diagnostics: [] } }
            : {}),
        },
        {
          onlyPluginIds: pluginIds,
          cache: true,
          activate: false,
        },
      ),
    );
    return deps.mapRegistryProviders({ registry, onlyPluginIds: pluginIds });
  }

  const shouldFilterProviders =
    params.config !== undefined ||
    params.onlyPluginIds !== undefined ||
    params.origin !== undefined ||
    params.sandboxed === true;
  const { config, activationSourceConfig, autoEnabledReasons, manifestRecords } =
    deps.resolveBundledResolutionConfig({
      ...params,
      workspaceDir,
      env,
    });
  const discoveredPluginIds = normalizePluginIdScope(
    deps.resolveCandidatePluginIds({
      config: params.config,
      workspaceDir,
      env,
      onlyPluginIds: params.onlyPluginIds,
      origin: params.origin,
      sandboxed: params.sandboxed,
      ...(manifestRecords ? { manifestRecords } : {}),
    }),
  );
  const allowedPluginIds = config?.plugins?.allow;
  const allowSet = allowedPluginIds?.length
    ? new Set(allowedPluginIds.map((pluginId) => normalizePluginId(pluginId)))
    : undefined;
  const allowlistedPluginIds = allowSet
    ? discoveredPluginIds?.filter((pluginId) => allowSet.has(normalizePluginId(pluginId)))
    : discoveredPluginIds;
  const candidatePluginIds = allowlistedPluginIds?.length
    ? allowlistedPluginIds
    : discoveredPluginIds;
  const onlyPluginIds = shouldFilterProviders ? candidatePluginIds : undefined;
  const generationRegistry = getPluginRuntimeGenerationRegistry();
  const current = getCurrentPluginToolInspection(params.config, env, params.workspaceDir);
  if (generationRegistry && !current) {
    return deps.mapRegistryProviders({ registry: generationRegistry, onlyPluginIds });
  }
  const loadOptions = buildPluginRuntimeLoadOptions(
    {
      config,
      activationSourceConfig,
      autoEnabledReasons,
      workspaceDir,
      env,
      logger: createPluginRuntimeLoaderLogger(),
      manifestRegistry: params.manifestRecords
        ? { plugins: [...params.manifestRecords], diagnostics: [] }
        : undefined,
    },
    {
      cache: true,
      activate: false,
      ...(hasExplicitPluginIdScope(candidatePluginIds)
        ? { onlyPluginIds: candidatePluginIds }
        : {}),
    },
  );
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const compatible = current
    ? undefined
    : scopedRegistry
      ? registryContainsRuntimePluginIds(scopedRegistry, candidatePluginIds)
        ? scopedRegistry
        : undefined
      : getLoadedRuntimePluginRegistry({
          env,
          loadOptions,
          workspaceDir,
          requiredPluginIds: candidatePluginIds,
        });
  const hasExplicitEmptyScope = onlyPluginIds !== undefined && onlyPluginIds.length === 0;
  // Unknown candidates require a complete inspected inventory before absence is authoritative.
  if (compatible) {
    const providers = deps.mapRegistryProviders({
      registry: compatible,
      onlyPluginIds,
    });
    if (compatible === scopedRegistry) {
      const inspectedPluginIds = new Set(
        compatible.plugins
          .filter(
            (plugin) =>
              hasCompletedPluginRuntimeRegistration(plugin) ||
              plugin.status === "error" ||
              plugin.status === "disabled",
          )
          .map((plugin) => plugin.id),
      );
      if (
        candidatePluginIds !== undefined ||
        manifestRecords?.every((plugin) => inspectedPluginIds.has(plugin.id))
      ) {
        return providers;
      }
    } else if (providers.length > 0 || hasExplicitEmptyScope) {
      return providers;
    }
  }
  if (isPluginRegistryLoadInFlight(loadOptions)) {
    return [];
  }
  if (hasExplicitEmptyScope) {
    return [];
  }
  if (candidatePluginIds && deps.resolveBundledRuntimeArtifactProviders) {
    const bundledArtifactProviders = deps.resolveBundledRuntimeArtifactProviders({
      config,
      workspaceDir,
      env,
      onlyPluginIds: candidatePluginIds,
      ...(manifestRecords ? { manifestRecords } : {}),
    });
    if (bundledArtifactProviders) {
      return bundledArtifactProviders;
    }
  }
  const inspectedManifests = manifestRecords ?? current?.loadContext.manifestRegistry?.plugins;
  if (current && inspectedManifests) {
    const candidates = candidatePluginIds && new Set(candidatePluginIds);
    const retainedPluginIds = new Set(
      inspectedManifests
        .filter(
          (manifest) =>
            (!candidates || candidates.has(manifest.id)) &&
            samePluginToolSource(current.inspection.manifests.get(manifest.id), manifest),
        )
        .map((manifest) => manifest.id),
    );
    // Undefined candidates retain legacy discovery, including undeclared external providers.
    const missingPluginIds = (
      candidatePluginIds ?? inspectedManifests.map((manifest) => manifest.id)
    ).filter((id) => !retainedPluginIds.has(id));
    const supplementalOptions: PluginLoadOptions = {
      ...loadOptions,
      onlyPluginIds: missingPluginIds,
      manifestRegistry: {
        plugins: [...inspectedManifests],
        diagnostics: current.loadContext.manifestRegistry?.diagnostics ?? [],
      },
      installRecords: current.loadContext.installRecords,
      preferBuiltPluginArtifacts: current.loadContext.preferBuiltPluginArtifacts,
      expectedSourceDigests: current.loadContext.expectedSourceDigests,
    };
    const supplemental = missingPluginIds.length
      ? current.inspection.withSupplementalCache(() =>
          isPluginRegistryLoadInFlight(supplementalOptions)
            ? undefined
            : loadOpenClawPlugins(supplementalOptions),
        )
      : undefined;
    current.inspection.assertCurrent();
    // Registration order, not inspection selection order, decides duplicate provider ids.
    const registry: PluginRegistry = {
      ...current.registry,
      plugins: [
        ...current.registry.plugins.filter((plugin) => retainedPluginIds.has(plugin.id)),
        ...(supplemental?.plugins ?? []),
      ],
      webSearchProviders: mergeInspectedProviderEntries(
        inspectedManifests,
        retainedPluginIds,
        current.registry.webSearchProviders,
        supplemental?.webSearchProviders ?? [],
      ),
      webFetchProviders: mergeInspectedProviderEntries(
        inspectedManifests,
        retainedPluginIds,
        current.registry.webFetchProviders,
        supplemental?.webFetchProviders ?? [],
      ),
    };
    return deps.mapRegistryProviders({ registry, onlyPluginIds });
  }
  const registry = loadOpenClawPlugins(loadOptions);
  return deps.mapRegistryProviders({
    registry,
    onlyPluginIds,
  });
}
