// Discovers, validates, and loads plugin metadata and runtime entrypoints.
import { clearAgentHarnesses } from "../agents/harness/registry.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { clearDetachedTaskLifecycleRuntimeRegistration } from "../tasks/detached-task-runtime-state.js";
import { clearPluginCommands } from "./command-registry-state.js";
import { clearCompactionProviders } from "./compaction-provider.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { clearEmbeddingProviders } from "./embedding-providers.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { clearPluginInteractiveHandlers } from "./interactive-registry.js";
import {
  clearPluginRegistryLoadCache,
  getReusableCachedPluginRegistry,
  hasExplicitCompatibilityInputs,
  isPluginRegistryLoadInFlight,
  pluginLoaderCacheState,
  pluginLoadOptionsMatchCacheKey,
  pluginToolDiscoveryOptionsMatchActiveCacheKey,
  resolvePluginLoadCacheContext,
  resolvePluginRegistryLoadCacheKey,
  resolveRuntimeSubagentMode,
  scopedPluginLoadOptionsMatchWiderActiveCacheKey,
  setCachedPluginRegistry,
  type RuntimeSubagentMode,
} from "./loader-cache.js";
import { createLazyPluginRuntime, createPluginModuleLoader } from "./loader-module.js";
import { warnAboutUntrackedLoadedPlugins, warnWhenAllowlistIsOpen } from "./loader-provenance.js";
import { formatPluginFailureSummary } from "./loader-records.js";
import { maybeThrowOnPluginLoadError, pushDiagnostics } from "./loader-registration.js";
import {
  loadRuntimePluginCandidate,
  type RuntimePluginLoadContext,
  type RuntimePluginLoadState,
} from "./loader-runtime-candidate.js";
import {
  createPluginCandidatesFromManifestRegistry,
  defaultPluginLogger,
  preparePluginCandidates,
  resolveAuthorizedDreamingSidecar,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { clearMemoryEmbeddingProviders } from "./memory-embedding-providers.js";
import { clearMemoryPluginState } from "./memory-state.js";
import {
  restorePluginProcessGlobalState,
  snapshotPluginProcessGlobalState,
} from "./plugin-registration-transaction.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry, type PluginRegistry } from "./registry.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
  setActivePluginRegistry,
} from "./runtime.js";

export type { PluginLoadOptions } from "./loader-types.js";
export { loadOpenClawPluginCliRegistry } from "./loader-cli.js";
export {
  clearPluginRegistryLoadCache,
  isPluginRegistryLoadInFlight,
  resolvePluginRegistryLoadCacheKey,
};

export function clearActivatedPluginRuntimeState(): void {
  clearAgentHarnesses();
  clearPluginCommands();
  clearCompactionProviders();
  clearDetachedTaskLifecycleRuntimeRegistration();
  clearPluginInteractiveHandlers();
  clearEmbeddingProviders();
  clearMemoryEmbeddingProviders();
  clearMemoryPluginState();
}

function activatePluginRegistry(
  registry: PluginRegistry,
  cacheKey: string,
  runtimeSubagentMode: RuntimeSubagentMode,
  workspaceDir?: string,
): void {
  // The runner resolves hooks from active and pinned registries. Reinitialize on
  // every activation so scope and activation order cannot drop registered hooks.
  setActivePluginRegistry(registry, cacheKey, runtimeSubagentMode, workspaceDir);
  initializeGlobalHookRunner(registry);
}

function getCompatibleActivePluginRegistry(
  options: PluginLoadOptions = {},
): PluginRegistry | undefined {
  if (options.resolveRawConfigEnvVars === true) {
    return undefined;
  }
  const activeRegistry = getActivePluginRegistry() ?? undefined;
  if (!activeRegistry) {
    return undefined;
  }
  if (!hasExplicitCompatibilityInputs(options)) {
    return activeRegistry;
  }
  const activeCacheKey = getActivePluginRegistryKey();
  if (!activeCacheKey) {
    return undefined;
  }
  const loadContext = resolvePluginLoadCacheContext(options);
  const matchesActiveCacheKey = (candidate: PluginLoadOptions): boolean => {
    if (pluginLoadOptionsMatchCacheKey(candidate, activeCacheKey)) {
      return true;
    }
    if (candidate.coreGatewayMethodNames !== undefined) {
      return false;
    }
    return pluginLoadOptionsMatchCacheKey(
      { ...candidate, coreGatewayMethodNames: activeRegistry.coreGatewayMethodNames },
      activeCacheKey,
    );
  };
  const matchesCompatibleActiveRegistry = (candidate: PluginLoadOptions): boolean =>
    matchesActiveCacheKey(candidate) ||
    scopedPluginLoadOptionsMatchWiderActiveCacheKey(candidate, activeCacheKey, activeRegistry) ||
    pluginToolDiscoveryOptionsMatchActiveCacheKey(candidate, activeCacheKey);
  const matchesActivationVariants = (candidate: PluginLoadOptions): boolean =>
    matchesCompatibleActiveRegistry(candidate) ||
    (!loadContext.shouldActivate &&
      matchesCompatibleActiveRegistry({ ...candidate, activate: true }));

  if (matchesActivationVariants(options)) {
    return activeRegistry;
  }
  const activeRuntimeSubagentMode = getActivePluginRuntimeSubagentMode();
  if (
    activeRuntimeSubagentMode === "gateway-bindable" &&
    matchesActivationVariants({ ...options, preferBuiltPluginArtifacts: true })
  ) {
    return activeRegistry;
  }
  if (
    loadContext.runtimeSubagentMode === "default" &&
    activeRuntimeSubagentMode === "gateway-bindable"
  ) {
    const gatewayBindableOptions: PluginLoadOptions = {
      ...options,
      runtimeOptions: {
        ...options.runtimeOptions,
        allowGatewaySubagentBinding: true,
      },
    };
    if (
      matchesActivationVariants(gatewayBindableOptions) ||
      matchesActivationVariants({
        ...gatewayBindableOptions,
        preferBuiltPluginArtifacts: true,
      })
    ) {
      return activeRegistry;
    }
  }
  return undefined;
}

export function resolveRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  if (!options || !hasExplicitCompatibilityInputs(options)) {
    return getCompatibleActivePluginRegistry();
  }
  const compatible = getCompatibleActivePluginRegistry(options);
  if (compatible) {
    return compatible;
  }
  // Helper/runtime callers must not recurse into the same snapshot load while
  // plugin registration is in flight. Direct loads still surface the hard error.
  if (isPluginRegistryLoadInFlight(options)) {
    return undefined;
  }
  return loadOpenClawPlugins(options);
}

export function getRuntimePluginRegistryForLoadOptions(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  return resolveRuntimePluginRegistry(options);
}

export function resolveCompatibleRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  return getCompatibleActivePluginRegistry(options);
}

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const requestedOnlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
  const requestedOnlyPluginIdSet = createPluginIdScopeSet(requestedOnlyPluginIds);
  if (requestedOnlyPluginIdSet && requestedOnlyPluginIdSet.size === 0) {
    const emptyRegistry = createEmptyPluginRegistry();
    if (options.activate !== false) {
      clearActivatedPluginRuntimeState();
      const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
      activatePluginRegistry(
        emptyRegistry,
        `empty-plugin-scope::${runtimeSubagentMode}::${options.workspaceDir ?? ""}`,
        runtimeSubagentMode,
        options.workspaceDir,
      );
    }
    return emptyRegistry;
  }

  const loadContext = resolvePluginLoadCacheContext(options);
  const {
    env,
    cfg,
    normalized,
    activationSource,
    autoEnabledReasons,
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    requireSetupEntryForSetupOnlyChannelPlugins,
    preferSetupRuntimeForChannelPlugins,
    forceFullRuntimeForChannelPlugins,
    preferBuiltPluginArtifacts,
    shouldActivate,
    shouldLoadModules,
    cacheKey,
    runtimeSubagentMode,
    installRecords,
    devSourceRoot,
  } = loadContext;
  const logger = options.logger ?? defaultPluginLogger();
  const validateOnly = options.mode === "validate";
  const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);
  const cacheEnabled = options.cache !== false && options.resolveRawConfigEnvVars !== true;
  if (cacheEnabled) {
    const cached = getReusableCachedPluginRegistry({
      cacheKey,
      onlyPluginIds,
      runtimeSubagentMode,
      options,
    });
    if (cached) {
      if (shouldActivate) {
        restorePluginProcessGlobalState(cached.state.processGlobalState);
        activatePluginRegistry(
          cached.state.registry,
          cached.cacheKey,
          cached.runtimeSubagentMode,
          options.workspaceDir,
        );
      }
      return cached.state.registry;
    }
  }

  pluginLoaderCacheState.beginLoad(cacheKey);
  try {
    if (shouldActivate) {
      clearActivatedPluginRuntimeState();
    }
    const loadPluginModule = createPluginModuleLoader({
      devSourceRoot,
      pluginSdkResolution: options.pluginSdkResolution,
    });
    const runtime = createLazyPluginRuntime({
      loadPluginModule,
      devSourceRoot,
      pluginSdkResolution: options.pluginSdkResolution,
      runtimeOptions: options.runtimeOptions,
    });
    const registryBuilder = createPluginRegistry({
      logger,
      runtime,
      coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
      ...(options.coreGatewayMethodNames !== undefined && {
        coreGatewayMethodNames: options.coreGatewayMethodNames,
      }),
      ...(options.hostServices !== undefined && { hostServices: options.hostServices }),
      activateGlobalSideEffects: shouldActivate,
    });
    const { registry } = registryBuilder;
    const suppliedManifestRegistry = options.manifestRegistry;
    const discovery = suppliedManifestRegistry
      ? {
          candidates: createPluginCandidatesFromManifestRegistry(suppliedManifestRegistry),
          diagnostics: [] as PluginDiagnostic[],
        }
      : (options.discovery ??
        discoverOpenClawPlugins({
          workspaceDir: options.workspaceDir,
          extraPaths: normalized.loadPaths,
          env,
          installRecords,
        }));
    const manifestRegistry =
      suppliedManifestRegistry ??
      loadPluginManifestRegistry({
        config: cfg,
        workspaceDir: options.workspaceDir,
        env,
        candidates: discovery.candidates,
        diagnostics: discovery.diagnostics,
        installRecords: Object.keys(installRecords).length > 0 ? installRecords : undefined,
      });
    pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
    warnWhenAllowlistIsOpen({
      emitWarning: shouldActivate,
      logger,
      pluginsEnabled: normalized.enabled,
      allow: normalized.allow,
      warningCacheKey: cacheKey,
      warningCache: pluginLoaderCacheState,
      explicitlyEnabledPluginIds: new Set(
        Object.entries(normalized.entries)
          .filter(([, entry]) => entry.enabled === true)
          .map(([pluginId]) => pluginId),
      ),
      discoverablePlugins: manifestRegistry.plugins
        .filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))
        .map((plugin) => ({ id: plugin.id, source: plugin.source, origin: plugin.origin })),
    });
    const { manifestByRoot, orderedCandidates, provenance } = preparePluginCandidates({
      discovery,
      manifestRegistry,
      normalizedLoadPaths: normalized.loadPaths,
      env,
      installRecords,
    });
    const memorySlot = normalized.slots.memory;
    const state: RuntimePluginLoadState = {
      seenIds: new Map(),
      selectedMemoryPluginId: null,
      memorySlotMatched: false,
      pluginLoadAttemptCount: 0,
    };
    const dreamingSidecar = resolveAuthorizedDreamingSidecar({
      cfg,
      normalized,
      activationSource,
      manifestRegistry,
      memorySlot,
    });
    const candidateContext: RuntimePluginLoadContext = {
      options,
      env,
      cfg,
      normalized,
      activationSource,
      autoEnabledReasons,
      onlyPluginIdSet,
      includeSetupOnlyChannelPlugins,
      forceSetupOnlyChannelPlugins,
      requireSetupEntryForSetupOnlyChannelPlugins,
      preferSetupRuntimeForChannelPlugins,
      forceFullRuntimeForChannelPlugins,
      preferBuiltPluginArtifacts,
      shouldActivate,
      shouldLoadModules,
      validateOnly,
      memorySlot,
      dreamingSidecar,
      registry,
      createApi: registryBuilder.createApi,
      rollbackPluginGlobalSideEffects: registryBuilder.rollbackPluginGlobalSideEffects,
      registerReload: registryBuilder.registerReload,
      registerNodeHostCommand: registryBuilder.registerNodeHostCommand,
      registerSecurityAuditCollector: registryBuilder.registerSecurityAuditCollector,
      loadPluginModule,
      logger,
    };
    const pluginLoadStartMs = performance.now();
    for (const candidate of orderedCandidates) {
      const manifestRecord = manifestByRoot.get(candidate.rootDir);
      if (manifestRecord) {
        loadRuntimePluginCandidate(candidateContext, candidate, manifestRecord, state);
      }
    }
    const pluginLoadElapsedMs = performance.now() - pluginLoadStartMs;
    if (state.pluginLoadAttemptCount > 0) {
      logger.debug?.(
        `[plugins] loaded ${registry.plugins.length} plugin(s) (${state.pluginLoadAttemptCount} attempted) in ${pluginLoadElapsedMs.toFixed(1)}ms`,
      );
    }
    if (!onlyPluginIdSet && typeof memorySlot === "string" && !state.memorySlotMatched) {
      registry.diagnostics.push({
        level: "warn",
        message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
      });
    }
    warnAboutUntrackedLoadedPlugins({
      registry,
      provenance,
      allowlist: normalized.allow,
      emitWarning: shouldActivate,
      logger,
      env,
    });
    maybeThrowOnPluginLoadError(registry, options.throwOnLoadError);
    if (shouldActivate && options.mode !== "validate") {
      const failedPlugins = registry.plugins.filter((plugin) => plugin.failedAt != null);
      if (failedPlugins.length > 0) {
        logger.warn(
          `[plugins] ${failedPlugins.length} plugin(s) failed to initialize (${formatPluginFailureSummary(
            failedPlugins,
          )}). Run 'openclaw plugins inspect <id> --runtime --json' for runtime diagnostics, 'openclaw plugins list' for registry state, and restart the Gateway after plugin code or load-path changes.`,
        );
      }
    }
    if (cacheEnabled) {
      setCachedPluginRegistry(
        cacheKey,
        { registry, processGlobalState: snapshotPluginProcessGlobalState() },
        onlyPluginIds,
      );
    }
    if (shouldActivate) {
      activatePluginRegistry(registry, cacheKey, runtimeSubagentMode, options.workspaceDir);
    }
    return registry;
  } finally {
    pluginLoaderCacheState.finishLoad(cacheKey);
  }
}
