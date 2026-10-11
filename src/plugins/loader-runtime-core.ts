import { isDeepStrictEqual } from "node:util";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentToolResultMiddlewareRuntimeIds } from "./agent-tool-result-middleware.js";
import { createUnavailableRuntime } from "./api-builder.js";
import { resolvePluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCapabilityCatalogHostContext } from "./capability-catalog-context.types.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { isPluginRegistryCacheEnabled } from "./loader-cache.js";
import {
  resolvePluginLoadCacheContext,
  resolveRuntimeSubagentMode,
} from "./loader-load-context.js";
import { createLazyPluginRuntime, createPluginModuleLoader } from "./loader-module-runtime.js";
import {
  buildProvenanceIndex,
  warnAboutUntrackedLoadedPlugins,
  warnWhenAllowlistIsOpen,
} from "./loader-provenance.js";
import { formatPluginFailureSummary } from "./loader-records.js";
import {
  loadRuntimePluginCandidate,
  prepareRuntimePluginConfig,
  type PluginLoadLoopState,
  type PreparedPluginConfig,
} from "./loader-runtime-candidate.js";
import {
  activatePluginRegistry,
  createPluginCandidatesFromManifestRegistry,
  matchesScopedPluginOrDreamingSidecar,
  maybeThrowOnPluginLoadError,
  resolveAuthorizedDreamingSidecar,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { getPluginCache } from "./plugin-cache.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import {
  isPluginRecordActive,
  isPluginRecordBorrowed,
  isPluginRegistryActivated,
  markPluginRecordBorrowed,
  withPluginRegistryPreparationScope,
} from "./registry-lifecycle.js";
import type { PluginRecord } from "./registry-types.js";
import { createPluginRegistry, type PluginRegistry } from "./registry.js";
import { degradedPluginMatchesRoot, findActiveDegradedPlugin } from "./runtime-degraded-state.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContextState } from "./runtime/load-context-state.js";
import { setPluginRuntimeLoadContext } from "./runtime/load-context.js";
import type { PluginRuntime } from "./runtime/types.js";
import { hasKind } from "./slots.js";

type PluginLoadInput = {
  source: string;
  signature: string | undefined;
  /** Load-mode-free identity recorded by side-effect runtime loads for non-activating borrowers. */
  borrowSignature?: string;
  config: PreparedPluginConfig;
};
const registryInputs = new WeakMap<PluginRegistry, Map<string, PluginLoadInput>>();

/** Captured JSON inputs ignore object key order, but preserve array order and values. */
function samePluginLoadInput(left: string | undefined, right: string | undefined): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      isDeepStrictEqual(JSON.parse(left), JSON.parse(right)))
  );
}

/**
 * Same-mode predecessors transfer to the candidate at publication. A live side-effect
 * runtime lends active records to a non-activating load and keeps their custody.
 */
function resolvePluginRecordRetention(
  { previousRegistry, borrowRegistry }: PluginLoadOptions,
  pluginId: string,
  params: { signature?: string; borrowSignature?: string; replaced: boolean },
): { registry: PluginRegistry; record: PluginRecord; input: PluginLoadInput } | undefined {
  const previous = previousRegistry?.plugins.find((record) => record.id === pluginId);
  const previousInput = previousRegistry && registryInputs.get(previousRegistry)?.get(pluginId);
  if (
    previousRegistry &&
    previous &&
    previousInput &&
    // A predecessor can transfer only its own instances, not another owner's loans.
    // Reborrow from the supplied lender so callbacks never retain the old borrower.
    !isPluginRecordBorrowed(previousRegistry, previous) &&
    params.signature !== undefined &&
    !params.replaced &&
    samePluginLoadInput(previousInput.signature, params.signature)
  ) {
    return { registry: previousRegistry, record: previous, input: previousInput };
  }
  const lent = borrowRegistry?.plugins.find((record) => record.id === pluginId);
  const lentInput = borrowRegistry && registryInputs.get(borrowRegistry)?.get(pluginId);
  return borrowRegistry &&
    lent &&
    lentInput?.borrowSignature !== undefined &&
    isPluginRecordActive(borrowRegistry, lent) &&
    samePluginLoadInput(lentInput.borrowSignature, params.borrowSignature)
    ? { registry: borrowRegistry, record: lent, input: lentInput }
    : undefined;
}

type PluginModuleLoaderOverrides = Pick<
  Parameters<typeof createPluginModuleLoader>[0],
  "tryNative" | "loaderFilename" | "installNativeSdkResolver"
>;
export type InternalPluginLoadOverrides = {
  moduleLoader: PluginModuleLoaderOverrides;
  runtime: Pick<PluginRuntime, "config" | "modelAuth" | "modelConfig">;
};

function createDeferredGatewaySubagentRuntime(runtime: PluginRuntime): PluginRuntime["subagent"] {
  const subagent: PluginRuntime["subagent"] = {
    complete: (...args) => runtime.subagent.complete(...args),
    run: (...args) => runtime.subagent.run(...args),
    waitForRun: (...args) => runtime.subagent.waitForRun(...args),
    getSessionMessages: (...args) => runtime.subagent.getSessionMessages(...args),
    deleteSession: (...args) => runtime.subagent.deleteSession(...args),
  };
  bindGatewayContextResolver(subagent, getGatewayContextResolver(runtime));
  return subagent;
}

function createDeferredGatewayNodesRuntime(runtime: PluginRuntime): PluginRuntime["nodes"] {
  return {
    list: (...args) => runtime.nodes.list(...args),
    invoke: (...args) => runtime.nodes.invoke(...args),
    openDuplex: (...args) => runtime.nodes.openDuplex(...args),
  };
}

export type NativePluginLoadBindings = Pick<PluginRuntime, "modelAuth" | "modelConfig"> & {
  capabilityCatalogContext: PluginCapabilityCatalogHostContext;
};

function createCapabilityCatalogContextResolver(
  context: NativePluginLoadBindings["capabilityCatalogContext"],
) {
  // Registrars retain this callback. Keep it outside the loader's lexical scope so
  // a live replacement cannot retain options.previousRegistry and all older generations.
  return () => context;
}

export function loadOpenClawPluginsCore(
  options: PluginLoadOptions,
  nativeBindings: NativePluginLoadBindings,
  overrides?: InternalPluginLoadOverrides,
  inspectionResources?: PluginRegistryInspectionResources,
  trackActivationCleanup?: (completion: Promise<void>) => void,
): PluginRegistry {
  if (getPluginCache().retirement) {
    throw new Error("Plugin inventory has retired; begin a new plugin operation.");
  }
  const requestedOnlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
  const requestedOnlyPluginIdSet = createPluginIdScopeSet(requestedOnlyPluginIds);
  if (requestedOnlyPluginIdSet && requestedOnlyPluginIdSet.size === 0) {
    const emptyRegistry = createEmptyPluginRegistry();
    inspectionResources?.attach(emptyRegistry);
    if (options.mode !== "cli-metadata" && options.activate !== false) {
      const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
      activatePluginRegistry(
        emptyRegistry,
        `empty-plugin-scope::${runtimeSubagentMode}::${options.workspaceDir ?? ""}`,
        runtimeSubagentMode,
        options.workspaceDir,
        undefined,
        trackActivationCleanup,
      );
    }
    return emptyRegistry;
  }

  const context = resolvePluginLoadCacheContext(options);
  const logger = options.logger ?? createSubsystemLogger("plugins");
  const validateOnly = options.mode === "validate";
  const onlyPluginIdSet = createPluginIdScopeSet(context.onlyPluginIds);
  const cacheEnabled =
    !options.previousRegistry &&
    !options.borrowRegistry &&
    !options.moduleRecoveries &&
    isPluginRegistryCacheEnabled(options);
  if (cacheEnabled) {
    const cached = context.cacheState.get(context.cacheKey);
    if (cached) {
      maybeThrowOnPluginLoadError(cached, options.throwOnLoadError);
      if (context.shouldActivate) {
        activatePluginRegistry(
          cached,
          context.cacheKey,
          context.runtimeSubagentMode,
          options.workspaceDir,
          undefined,
          trackActivationCleanup,
        );
      }
      return cached;
    }
  }

  context.cacheState.beginLoad(context.cacheKey);
  let registryBuilder: ReturnType<typeof createPluginRegistry> | undefined;
  try {
    // Module and runtime loading stay lazy for discovery-only or disabled-plugin paths.
    const loadPluginModule = createPluginModuleLoader({
      devSourceRoot: context.devSourceRoot,
      pluginSdkResolution: options.pluginSdkResolution,
      expectedSourceDigests: options.expectedSourceDigests,
      ...overrides?.moduleLoader,
    });
    const borrowedSubagent = context.borrowedGatewayRuntime
      ? createDeferredGatewaySubagentRuntime(context.borrowedGatewayRuntime)
      : undefined;
    const borrowedNodes = context.borrowedGatewayRuntime
      ? createDeferredGatewayNodesRuntime(context.borrowedGatewayRuntime)
      : undefined;
    const runtime =
      options.mode === "cli-metadata"
        ? createUnavailableRuntime("cli-metadata")
        : overrides?.runtime
          ? // Restricted discovery must not initialize full host services.
            // SAFETY: bundled-capability-runtime uses this base only for uncached, non-activating registration.
            (overrides.runtime as PluginRuntime)
          : createLazyPluginRuntime({
              devSourceRoot: context.devSourceRoot,
              pluginSdkResolution: options.pluginSdkResolution,
              runtimeOptions: {
                ...options.runtimeOptions,
                // Defaults are immutable host facts; each runtime retains its mutable method view.
                modelAuth: options.runtimeOptions?.modelAuth ?? { ...nativeBindings.modelAuth },
                modelConfig: options.runtimeOptions?.modelConfig ?? {
                  ...nativeBindings.modelConfig,
                },
                subagent: options.runtimeOptions?.subagent ?? borrowedSubagent,
                nodes: options.runtimeOptions?.nodes ?? borrowedNodes,
              },
            });
    const capabilityCatalogContext =
      options.capabilityCatalogContext ??
      options.capabilityCatalog?.context ??
      nativeBindings.capabilityCatalogContext;
    registryBuilder = createPluginRegistry({
      logger,
      runtime,
      resolveCapabilityCatalogContext:
        createCapabilityCatalogContextResolver(capabilityCatalogContext),
      allowProcessHomeSessionCatalogs: options.allowProcessHomeSessionCatalogs ?? true,
      coreGatewayHandlers: options.coreGatewayHandlers,
      ...(options.coreGatewayMethodNames !== undefined && {
        coreGatewayMethodNames: options.coreGatewayMethodNames,
      }),
      ...(options.hostServices !== undefined && { hostServices: options.hostServices }),
      activateGlobalSideEffects: context.runtimeSideEffects,
    });
    const builder = registryBuilder;
    const { registry } = builder;
    inspectionResources?.attach(registry);
    // The load context has verified the current generation's workspace, config, and scope.
    const suppliedManifestRegistry =
      options.manifestRegistry ??
      (options.discovery === undefined ? context.metadataSnapshot?.manifestRegistry : undefined);
    const discovery: PluginDiscoveryResult = suppliedManifestRegistry
      ? {
          candidates: createPluginCandidatesFromManifestRegistry(suppliedManifestRegistry),
          diagnostics: [],
        }
      : (options.discovery ??
        discoverOpenClawPlugins({
          workspaceDir: options.workspaceDir,
          extraPaths: context.normalized.loadPaths,
          env: context.env,
          installRecords: context.installRecords,
        }));
    const manifestRegistry =
      suppliedManifestRegistry ??
      loadPluginManifestRegistryCore({
        config: context.cfg,
        workspaceDir: options.workspaceDir,
        env: context.env,
        candidates: discovery.candidates,
        diagnostics: discovery.diagnostics,
        installRecords:
          Object.keys(context.installRecords).length > 0 ? context.installRecords : undefined,
      });
    registry.diagnostics.push(...manifestRegistry.diagnostics);
    warnWhenAllowlistIsOpen({
      emitWarning: context.shouldActivate,
      logger,
      pluginsEnabled: context.normalized.enabled,
      allow: context.normalized.allow,
      warningCacheKey: context.cacheKey,
      warningCache: context.cacheState,
      explicitlyEnabledPluginIds: new Set(
        Object.entries(context.normalized.entries)
          .filter(([, entry]) => entry.enabled === true)
          .map(([pluginId]) => pluginId),
      ),
      // Partial snapshots should only warn about plugins intentionally in scope.
      discoverablePlugins: manifestRegistry.plugins.filter(
        (plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id),
      ),
    });
    const provenance = buildProvenanceIndex({
      normalizedLoadPaths: context.normalized.loadPaths,
      env: context.env,
      installRecords: context.installRecords,
    });
    const manifestBySource = new Map(
      manifestRegistry.plugins.map((record) => [record.source, record]),
    );
    // Manifest selection owns duplicate precedence; runtime consumes only its winners.
    const orderedCandidates = discovery.candidates.flatMap((candidate) => {
      const manifest = manifestBySource.get(candidate.source);
      return manifest ? [{ candidate, manifest }] : [];
    });
    const loaderCacheIdentity = Object.freeze({
      requestKey: context.cacheKey,
      resolvedKey: context.resolveManifestCacheKey(manifestRegistry),
    });
    // Raw and prepared loads share one owner; absent workspace means shared-root scope.
    setPluginRuntimeLoadContext(
      registry,
      {
        rawConfig: options.config ?? {},
        config: context.cfg,
        activationSourceConfig: context.activationSourceConfig,
        autoEnabledReasons: context.autoEnabledReasons,
        workspaceDir: options.workspaceDir,
        env: context.env,
        logger,
        manifestRegistry,
        installRecords: context.installRecords,
        preferBuiltPluginArtifacts: options.preferBuiltPluginArtifacts,
      },
      context.registrationConfigKey,
    );
    const replacedIds = new Set([
      ...(options.replacePluginIds ?? []),
      ...(options.moduleRecoveries?.keys() ?? []),
    ]);
    const memorySlot = context.normalized.slots.memory;
    const dreamingSidecar = resolveAuthorizedDreamingSidecar({
      cfg: context.cfg,
      normalized: context.normalized,
      activationSource: context.activationSource,
      manifestRegistry,
      memorySlot,
    });
    const inputs = new Map<string, PluginLoadInput>();
    const retained = new Map<string, PluginRegistry["plugins"][number]>();
    for (const { candidate, manifest } of orderedCandidates) {
      if (
        inputs.has(manifest.id) ||
        !matchesScopedPluginOrDreamingSidecar({
          onlyPluginIdSet,
          pluginId: manifest.id,
          sidecar: dreamingSidecar,
        })
      ) {
        continue;
      }
      const activation = resolveEffectivePluginActivationState({
        id: manifest.id,
        origin: candidate.origin,
        channelIds: manifest.channels,
        config: context.normalized,
        rootConfig: context.cfg,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(manifest),
        activationSource: context.activationSource,
      });
      // Retention includes the committed install; same-version reinstalls can replace its code.
      const installOwner = resolvePluginCandidateInstallOwner(candidate);
      const { config: pluginConfig, ...entryPolicy } =
        context.normalized.entries[normalizePluginPolicyId(manifest.id)] ?? {};
      const preparedConfig: PreparedPluginConfig = { input: JSON.stringify(pluginConfig) };
      const degradedPlugin = findActiveDegradedPlugin(manifest.id);
      // Control UI builds apply through the UI-only plugins.controlUi.reload owner. An in-place
      // `openclaw plugins build` rewrites controlUi paths and the byte-derived schemaCacheKey, which
      // must not force an unrelated backend replacement. Declaration presence still decides
      // whether the browser catalog serves this record, and configSchema is compared by value.
      const { controlUi, schemaCacheKey: _schemaCacheKey, ...runtimeManifest } = manifest;
      const identityInputs = [
        candidate.source,
        candidate.origin,
        [installOwner, installOwner ? context.installRecords[installOwner] : undefined],
        { ...runtimeManifest, controlUi: controlUi !== undefined },
        activation,
        entryPolicy,
        degradedPlugin && degradedPluginMatchesRoot(degradedPlugin, candidate.rootDir)
          ? degradedPlugin
          : undefined,
        hasKind(manifest.kind, "memory") ? memorySlot : undefined,
        manifest.id === dreamingSidecar?.engineId ? dreamingSidecar : undefined,
        context.channelPluginLoadIntent,
        context.includeSetupOnlyChannelPlugins,
        context.forceSetupOnlyChannelPlugins,
        validateOnly,
      ];
      // Side-effect runtime loads lend their records; non-activating runtime loads borrow them.
      const runtimeRegistration =
        !validateOnly && options.mode !== "cli-metadata" && options.toolDiscovery !== true;
      const lends = runtimeRegistration && context.runtimeSideEffects;
      const borrows =
        runtimeRegistration && !context.runtimeSideEffects && options.borrowRegistry !== undefined;
      let signature: string | undefined;
      let borrowSignature: string | undefined;
      try {
        signature = JSON.stringify([
          ...identityInputs,
          context.artifactPreference,
          context.runtimeSideEffects,
          options.toolDiscovery === true,
          options.mode,
        ]);
        borrowSignature = lends || borrows ? JSON.stringify(identityInputs) : undefined;
      } catch (error) {
        // A malformed external schema must reach the validation diagnostic, not abort
        // sibling loading while preparing an optional runtime-retention signature.
        if (
          !(error instanceof RangeError) ||
          candidate.origin === "bundled" ||
          prepareRuntimePluginConfig({
            candidate,
            manifestRecord: manifest,
            context,
            preparedConfig,
          }).ok
        ) {
          throw error;
        }
      }
      inputs.set(manifest.id, {
        source: candidate.source,
        signature,
        ...(lends ? { borrowSignature } : {}),
        config: preparedConfig,
      });
      const retention = resolvePluginRecordRetention(options, manifest.id, {
        signature,
        borrowSignature: borrows ? borrowSignature : undefined,
        replaced: replacedIds.has(manifest.id),
      });
      if (retention) {
        // Reserve retained contributions before newcomers register. Reuse validation only after
        // matching policy/admission inputs, leaving excluded candidates on their existing path.
        if (retention.input.config.validation) {
          prepareRuntimePluginConfig({
            candidate,
            manifestRecord: manifest,
            context,
            preparedConfig,
          });
        }
        if (samePluginLoadInput(retention.input.config.input, preparedConfig.input)) {
          retained.set(manifest.id, retention.record);
          if (retention.registry === options.borrowRegistry) {
            markPluginRecordBorrowed(registry, retention.record);
          }
          projectPluginContributions(retention.registry, retention.record, registry);
        }
      }
    }
    for (const source of [options.previousRegistry, options.borrowRegistry]) {
      registry.diagnostics.push(
        ...(source?.diagnostics.filter((entry) => {
          const record = entry.pluginId && retained.get(entry.pluginId);
          return record && source.plugins.includes(record);
        }) ?? []),
      );
    }
    const selectedMiddlewareOwnerManifests = new Map<
      string,
      (typeof manifestRegistry.plugins)[number]
    >();
    for (const { manifest: record } of orderedCandidates) {
      if (!selectedMiddlewareOwnerManifests.has(record.id)) {
        selectedMiddlewareOwnerManifests.set(record.id, record);
      }
    }
    for (const record of selectedMiddlewareOwnerManifests.values()) {
      if (retained.has(record.id) || options.mode === "cli-metadata") {
        continue;
      }
      const activation = resolveEffectivePluginActivationState({
        id: record.id,
        origin: record.origin,
        channelIds: record.channels,
        config: context.normalized,
        rootConfig: context.cfg,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
        activationSource: context.activationSource,
      });
      const runtimes = normalizeAgentToolResultMiddlewareRuntimeIds(
        record.contracts?.agentToolResultMiddleware,
      );
      if (
        runtimes.length > 0 &&
        (record.origin === "bundled" || (activation.enabled && activation.explicitlyEnabled))
      ) {
        registry.agentToolResultMiddlewareOwners.push({
          pluginId: record.id,
          runtimes,
          manifest: record,
        });
      }
    }
    const state: PluginLoadLoopState = {
      seenIds: new Map(),
      selectedMemoryPluginId: null,
      memorySlotMatched: false,
      pluginLoadAttemptCount: 0,
    };
    const pluginLoadStartMs = performance.now();
    for (const { candidate, manifest: manifestRecord } of orderedCandidates) {
      const previous = retained.get(manifestRecord.id);
      if (previous && !state.seenIds.has(manifestRecord.id)) {
        registry.plugins.push(previous);
        state.seenIds.set(previous.id, previous.origin);
        if (previous.memorySlotSelected) {
          state.selectedMemoryPluginId = previous.id;
          state.memorySlotMatched = true;
        }
        continue;
      }
      const input = inputs.get(manifestRecord.id);
      const loadCandidate = () =>
        loadRuntimePluginCandidate({
          candidate,
          manifestRecord,
          context,
          options,
          onlyPluginIdSet,
          dreamingSidecar,
          validateOnly,
          registryBuilder: builder,
          loadPluginModule,
          logger,
          state,
          preparedConfig: input?.source === candidate.source ? input.config : { input: undefined },
        });
      if (options.previousRegistry) {
        withPluginRegistryPreparationScope(registry, loadCandidate);
      } else {
        loadCandidate();
      }
    }
    const pluginLoadElapsedMs = performance.now() - pluginLoadStartMs;
    if (state.pluginLoadAttemptCount > 0) {
      logger.debug?.(
        `[plugins] loaded ${registry.plugins.length} plugin(s) (${state.pluginLoadAttemptCount} attempted) in ${pluginLoadElapsedMs.toFixed(1)}ms`,
      );
    }
    // Scoped snapshots may omit the configured memory plugin intentionally.
    if (
      options.mode !== "cli-metadata" &&
      !onlyPluginIdSet &&
      typeof memorySlot === "string" &&
      !state.memorySlotMatched
    ) {
      registry.diagnostics.push({
        level: "warn",
        message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
      });
    }
    if (options.mode !== "cli-metadata") {
      warnAboutUntrackedLoadedPlugins({
        registry,
        provenance,
        allowlist: context.normalized.allow,
        emitWarning: context.shouldActivate,
        logger,
        env: context.env,
        installOwnerByPluginId: new Map(
          orderedCandidates.flatMap(({ candidate, manifest }) => {
            const installOwner = resolvePluginCandidateInstallOwner(candidate);
            return manifest.id && installOwner ? [[manifest.id, installOwner] as const] : [];
          }),
        ),
      });
    }
    maybeThrowOnPluginLoadError(
      registry,
      options.throwOnLoadError,
      retained,
      options.previousRegistry,
      replacedIds,
    );
    if (context.shouldActivate && options.mode !== "validate") {
      const failedPlugins = registry.plugins.filter((plugin) => plugin.failedAt != null);
      if (failedPlugins.length > 0) {
        logger.warn(
          `[plugins] ${failedPlugins.length} plugin(s) failed to initialize (${formatPluginFailureSummary(
            failedPlugins,
          )}). Run 'openclaw plugins inspect <id> --runtime --json' for runtime diagnostics and 'openclaw plugins list' for registry state. After fixing plugin code or load paths, run 'openclaw plugins reload <id>' to retry.`,
        );
      }
    }
    // Presence of this identity also admits immutable private-registry policy caching.
    getPluginRuntimeLoadContextState(registry)!.loaderCacheIdentity = loaderCacheIdentity;
    if (context.shouldActivate) {
      // Install the complete bundle before hook-runner initialization.
      activatePluginRegistry(
        registry,
        context.cacheKey,
        context.runtimeSubagentMode,
        options.workspaceDir,
        undefined,
        trackActivationCleanup,
      );
    }
    // Publish only complete registries: failed activation restores the prior runtime selection,
    // then the catch below can discard this builder without poisoning a reusable cache value.
    if (cacheEnabled) {
      context.cacheState.set(context.cacheKey, registry);
      if (loaderCacheIdentity.resolvedKey !== context.cacheKey) {
        context.cacheState.set(loaderCacheIdentity.resolvedKey, registry);
      }
    }
    registryInputs.set(registry, inputs);
    return registry;
  } catch (error) {
    // Published generations retain their callbacks until retirement joins admitted users.
    // Construction rollback owns only new records, never retained predecessor instances.
    if (registryBuilder && !isPluginRegistryActivated(registryBuilder.registry)) {
      for (const plugin of registryBuilder.registry.plugins.toReversed()) {
        if (
          !options.previousRegistry?.plugins.includes(plugin) &&
          !options.borrowRegistry?.plugins.includes(plugin)
        ) {
          registryBuilder.rollbackPluginGlobalSideEffects(plugin.id, plugin);
        }
      }
    }
    throw error;
  } finally {
    context.cacheState.finishLoad(context.cacheKey);
  }
}
