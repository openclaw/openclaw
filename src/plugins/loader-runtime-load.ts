/** Native composition entry for ordinary, restricted, and cold provider-hook loading. */
import { setImmediate as nextTurn } from "node:timers/promises";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { createExternalAuthRuntime } from "../agents/auth-profiles/external-auth.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { listProfilesForProvider } from "../agents/auth-profiles/profile-list.js";
import { createAuthProfileStoreRuntime } from "../agents/auth-profiles/store.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { resolveAllowedModelRefCore } from "../agents/model-selection-resolve.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import {
  createProviderHttpError,
  readProviderJsonResponse,
  readProviderTextResponse,
} from "../agents/provider-http-errors.js";
import { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
import { warn } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createDebugProxyWebSocketAgent, resolveDebugProxySettings } from "../proxy-capture/env.js";
import { captureWsEvent, captureWsEventAsync } from "../proxy-capture/runtime.js";
import { createRealtimeTranscriptionWebSocketSession } from "../realtime-transcription/websocket-session.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveCompatibleRuntimePluginRegistry } from "./active-runtime-registry.js";
import type { PluginCapabilityCatalogHostContext } from "./capability-catalog-context.types.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { isCachedPluginRegistryLoad, isPluginRegistryLoadInFlight } from "./loader-cache.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import {
  loadOpenClawPluginsCore,
  loadOpenClawPluginsSteps,
  type InternalPluginLoadOverrides,
  type NativePluginLoadBindings,
} from "./loader-runtime-core.js";
import { maybeThrowOnPluginLoadError } from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  createPluginCache,
  getPluginCache,
  releasePluginCacheInstance,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { getPluginInstance, getPluginInstanceOwner } from "./plugin-instance-scope.js";
import { inheritPluginNativeAdmissions } from "./plugin-native-admission-state.js";
import { createProviderAuthAvailability } from "./provider-auth-availability-core.js";
import { createProviderExternalAuthResolver } from "./provider-external-auth-core.js";
import { createProviderHookRuntime } from "./provider-hook-runtime-core.js";
import { createProviderRegistryResolver } from "./providers.runtime-core.js";
import { PluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import type { PluginRegistry } from "./registry-types.js";
import { PluginRuntimeCloseRetainedError } from "./runtime-close-error.js";
import type { PluginRuntime } from "./runtime/types.js";

const loadModelAuthRuntime = createLazyRuntimeModule(
  () => import("./runtime/runtime-model-auth.runtime.js"),
);

// Construction only binds callbacks. No profile reads, plugin loads, or network work occur here.
// Hoisted entry functions let cold auth discovery re-enter this same binding without a module cycle.
export function resolveRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  const activeRegistry = resolveCompatibleRuntimePluginRegistry(options);
  if (activeRegistry) {
    return activeRegistry;
  }
  // Runtime helpers must not recurse while this exact snapshot is registering.
  return isPluginRegistryLoadInFlight(options)
    ? undefined
    : loadOpenClawPlugins({ ...options, activate: false });
}
const providerRegistry = Object.freeze(
  createProviderRegistryResolver({
    loadOpenClawPlugins,
    acquirePluginRegistryForInspection,
    resolveRuntimePluginRegistry,
    isPluginRegistryLoadInFlight,
  }),
);
const providerHooks = Object.freeze(createProviderHookRuntime(providerRegistry));
const externalProfiles = Object.freeze(createProviderExternalAuthResolver(providerHooks));
const externalAuth = Object.freeze(
  createExternalAuthRuntime(
    externalProfiles.resolveExternalAuthProfilesWithPlugins,
    externalProfiles.withPreparedExternalAuthProfiles,
  ),
);
const authStore = Object.freeze(createAuthProfileStoreRuntime(externalAuth));
const authAvailability = Object.freeze(
  createProviderAuthAvailability(authStore, providerHooks.resolveProviderRuntimePlugin),
);
let modelAuth: NativePluginLoadBindings["modelAuth"] | undefined;
let modelConfig: NativePluginLoadBindings["modelConfig"] | undefined;
let capabilityCatalogContext: NativePluginLoadBindings["capabilityCatalogContext"] | undefined;
// Imports of store/hook facades must not construct unrelated policy surfaces.
// Consumers share immutable defaults and retain their own mutable method views.
const loaderBindings: NativePluginLoadBindings = {
  get modelAuth() {
    if (!modelAuth) {
      const getApiKeyForModel = createLazyRuntimeMethod(
        loadModelAuthRuntime,
        (runtime) => runtime.getApiKeyForModel,
      );
      const getRuntimeAuthForModel = createLazyRuntimeMethod(
        loadModelAuthRuntime,
        (runtime) => runtime.getRuntimeAuthForModelCore,
      );
      const resolveApiKeyForProvider = createLazyRuntimeMethod(
        loadModelAuthRuntime,
        (runtime) => runtime.resolveProviderRuntimeApiKey,
      );
      modelAuth = {
        resolveProviderIdForAuth,
        ensureAuthProfileStore: authStore.ensureAuthProfileStore,
        ensureAuthProfileStoreAsync: authStore.ensureAuthProfileStoreAsync,
        resolveAuthProfileOrder,
        listProfilesForProvider,
        isProviderApiKeyConfigured: authAvailability.isProviderApiKeyConfigured,
        isProviderApiKeyConfiguredAsync: authAvailability.isProviderApiKeyConfiguredAsync,
        getApiKeyForModel: (params) =>
          getApiKeyForModel({
            model: params.model,
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
          }),
        getRuntimeAuthForModel: (params) =>
          getRuntimeAuthForModel({
            model: params.model,
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
          }),
        resolveApiKeyForProvider: (params) =>
          resolveApiKeyForProvider({
            provider: params.provider,
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
          }),
      };
    }
    return modelAuth;
  },
  get modelConfig() {
    return (modelConfig ??= {
      resolveDefaultModelForAgent,
      resolveAllowedModelRef: resolveAllowedModelRefCore,
      resolveModelRuntimePolicy,
    });
  },
  get capabilityCatalogContext() {
    return (capabilityCatalogContext ??= Object.freeze({
      isProviderApiKeyConfigured: authAvailability.isProviderApiKeyConfigured,
      isProviderApiKeyConfiguredAsync: authAvailability.isProviderApiKeyConfiguredAsync,
      isProviderAuthProfileConfigured: authAvailability.isProviderAuthProfileConfigured,
      isProviderAuthProfileConfiguredAsync: authAvailability.isProviderAuthProfileConfiguredAsync,
      resolveAgentDir,
      createRealtimeTranscriptionWebSocketSession,
      resolveProviderRequestHeaders,
      resolveProviderAuthProfileApiKey: authAvailability.resolveProviderAuthProfileApiKey,
      resolveApiKeyForProvider: async (
        params: Parameters<PluginCapabilityCatalogHostContext["resolveApiKeyForProvider"]>[0],
      ) =>
        (await import("./runtime/runtime-model-auth.runtime.js")).resolveProviderRuntimeApiKey(
          params,
        ),
      captureWsEvent,
      captureWsEventAsync,
      createDebugProxyWebSocketAgent,
      resolveDebugProxySettings,
      fetchWithSsrFGuard,
      createProviderHttpError,
      readProviderJsonResponse,
      readProviderTextResponse,
      formatErrorMessage,
      warn,
      redactSensitiveText,
    }));
  },
};

export const nativePluginBindings = Object.freeze({
  providerRegistry,
  providerHooks,
  externalProfiles,
  externalAuth,
  authStore,
  authAvailability,
});

export function resolvePluginCapabilityCatalogContext() {
  return loaderBindings.capabilityCatalogContext;
}
export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  return loadOpenClawPluginsCore(options, loaderBindings);
}

// Yielding loads can overlap, and a second same-key load would trip reentry detection. A
// same-key caller joins the pending load instead and receives the registry it would otherwise
// read from the cache once that load finished, checked against its own error policy.
type PendingCachedLoad = { promise: Promise<PluginRegistry>; strict: boolean };
const pendingCachedLoads = new WeakMap<object, Map<string, PendingCachedLoad>>();

/** Keep network callbacks responsive without publishing a partially registered generation. */
export async function loadOpenClawPluginsAsync(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const load = () => runPluginLoadStepsAsync(loadOpenClawPluginsSteps(options, loaderBindings));
  if (options.activate !== false || !isCachedPluginRegistryLoad(options)) {
    return load();
  }
  const { cacheState, cacheKey } = resolvePluginLoadCacheContext(options);
  let pending = pendingCachedLoads.get(cacheState);
  if (!pending) {
    pending = new Map();
    pendingCachedLoads.set(cacheState, pending);
  }
  const strict = options.throwOnLoadError === true;
  for (let joined = pending.get(cacheKey); joined; joined = pending.get(cacheKey)) {
    if (!joined.strict) {
      // A lenient load returns every diagnostic, as a cache hit would; apply this caller's policy.
      const registry = await joined.promise;
      maybeThrowOnPluginLoadError(registry, options.throwOnLoadError);
      return registry;
    }
    if (strict) {
      return joined.promise;
    }
    // A strict load discards a failed registry, so a lenient caller loads its own once it settles.
    try {
      return await joined.promise;
    } catch {
      if (pending.get(cacheKey) === joined) {
        pending.delete(cacheKey);
      }
    }
  }
  const entry: PendingCachedLoad = { promise: load(), strict };
  pending.set(cacheKey, entry);
  try {
    return await entry.promise;
  } finally {
    if (pending.get(cacheKey) === entry) {
      pending.delete(cacheKey);
    }
  }
}

async function runPluginLoadStepsAsync(
  steps: ReturnType<typeof loadOpenClawPluginsSteps>,
): Promise<PluginRegistry> {
  let step = steps.next();
  while (!step.done) {
    await nextTurn();
    try {
      await step.value?.();
      step = steps.next();
    } catch (error) {
      step = steps.throw(error);
    }
  }
  return step.value;
}

/** Publishes synchronously, then joins every accepted health write before returning to its host. */
export async function loadAndActivateRootPluginRegistry(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const cleanup: Promise<void>[] = [];
  try {
    return await runPluginLoadStepsAsync(
      loadOpenClawPluginsSteps(
        { ...options, activate: true },
        loaderBindings,
        undefined,
        undefined,
        (completion) => cleanup.push(completion),
      ),
    );
  } finally {
    await Promise.allSettled(cleanup);
  }
}

/** Acquires a fresh discovery registry; release waits for its registration resources. */
export async function acquirePluginRegistryForInspection(
  options: Omit<PluginLoadOptions, "activate" | "cache"> = {},
): Promise<{ registry: PluginRegistry; release: () => Promise<void> }> {
  return acquireRegistryResources(
    (resources) =>
      runPluginLoadStepsAsync(
        loadOpenClawPluginsSteps(
          { ...options, activate: false, cache: false },
          loaderBindings,
          undefined,
          resources,
        ),
      ),
    options,
  );
}

async function acquireRegistryResources(
  load: (resources: PluginRegistryInspectionResources) => PluginRegistry | Promise<PluginRegistry>,
  options: Pick<PluginLoadOptions, "metadataSnapshot" | "env">,
): Promise<{ registry: PluginRegistry; release: () => Promise<void> }> {
  const cache = createPluginCache();
  const resources = new PluginRegistryInspectionResources(async (registry, rollbackInstances) => {
    const instances = new Set(cache.instances);
    for (const record of registry?.plugins ?? []) {
      const instance = getPluginInstance(record);
      // Borrowed records stay in the lending registry's custody.
      if (instance && instance.owner?.registry === registry) {
        instances.add(instance);
      }
    }
    // Inspections own disposal, not host cleanup notifications or persistent session state.
    // Construction owns rollback diagnostics; final release still joins physical cleanup.
    const results = await Promise.allSettled(
      [...instances]
        .filter((instance) => {
          const owner = getPluginInstanceOwner(instance);
          return !owner || owner.registry === registry;
        })
        .map(async (instance) => {
          const result = await instance.dispose(undefined, { waitForSettlement: true });
          return rollbackInstances.has(instance) ? { errors: [] } : result;
        }),
    );
    const failures: unknown[] = results.flatMap((result) =>
      result.status === "rejected"
        ? [new PluginRuntimeCloseRetainedError(result.reason)]
        : result.value.errors,
    );
    for (const instance of instances) {
      releasePluginCacheInstance(instance, cache);
    }
    try {
      const retired = await retirePluginCache(cache, undefined, { waitForSettlement: true });
      failures.push(...retired.failures.map((failure) => failure.error));
    } catch (reason) {
      failures.push(new PluginRuntimeCloseRetainedError(reason));
    }
    if (failures.length) {
      throw new AggregateError(failures, "Plugin inspection instances failed to retire");
    }
  });
  try {
    inheritPluginNativeAdmissions(getPluginCache(), cache);
    const loadRegistry = () => load(resources);
    // Compose the supplied generation before entering the private registration cache.
    const registry = await (options.metadataSnapshot
      ? withPluginMetadataSnapshotScope(options.metadataSnapshot, loadRegistry, {
          cache,
          env: options.env,
        })
      : withPluginCache(cache, loadRegistry));
    // An inline closure shares the retirement callback's context, including the cache.
    return { registry, release: resources.release.bind(resources) };
  } catch (error) {
    try {
      await resources.release();
    } catch (disposalError) {
      throw new AggregateError(
        [error, disposalError],
        "Plugin inspection failed and its resources could not be disposed",
        { cause: disposalError },
      );
    }
    throw error;
  }
}

type ScopedRuntimeOverrides = Omit<InternalPluginLoadOverrides, "runtime"> & {
  runtime: Pick<PluginRuntime, "config"> &
    Partial<Pick<PluginRuntime, "modelAuth" | "modelConfig">>;
};

export function loadOpenClawPluginsWithInternalOverrides(
  options: PluginLoadOptions & { cache: false },
  overrides: ScopedRuntimeOverrides,
): PluginRegistry {
  const steps = loadRegistryWithInternalOverridesSteps(options, overrides);
  let step = steps.next();
  while (!step.done) {
    step = steps.next();
  }
  return step.value;
}

/** Owns the same narrow capability runtime without publishing or caching its registrations. */
export function acquirePluginRegistryWithInternalOverrides(
  options: PluginLoadOptions & { cache: false; activate: false },
  overrides: ScopedRuntimeOverrides,
): Promise<{ registry: PluginRegistry; release: () => Promise<void> }> {
  return acquireRegistryResources(
    (resources) =>
      runPluginLoadStepsAsync(
        loadRegistryWithInternalOverridesSteps(options, overrides, resources),
      ),
    options,
  );
}

function loadRegistryWithInternalOverridesSteps(
  options: PluginLoadOptions & { cache: false },
  overrides: ScopedRuntimeOverrides,
  resources?: PluginRegistryInspectionResources,
): ReturnType<typeof loadOpenClawPluginsSteps> {
  const runtimeModelAuth = overrides.runtime.modelAuth ??
    options.runtimeOptions?.modelAuth ?? { ...loaderBindings.modelAuth };
  const runtimeModelConfig = overrides.runtime.modelConfig ??
    options.runtimeOptions?.modelConfig ?? { ...loaderBindings.modelConfig };
  // Policy facets stay getter-only; their method views remain mutable per runtime.
  const runtime = {
    config: overrides.runtime.config,
    get modelAuth() {
      return runtimeModelAuth;
    },
    get modelConfig() {
      return runtimeModelConfig;
    },
  };
  // Preserve supplied lazy services without reading their getters during registration.
  const runtimeDescriptors = Object.getOwnPropertyDescriptors(overrides.runtime);
  delete runtimeDescriptors.modelAuth;
  delete runtimeDescriptors.modelConfig;
  Object.defineProperties(runtime, runtimeDescriptors);
  return loadOpenClawPluginsSteps(options, loaderBindings, { ...overrides, runtime }, resources);
}

export function resolveNativePluginModelAuth(): PluginRuntime["modelAuth"] {
  return { ...loaderBindings.modelAuth };
}
export function resolveNativePluginModelConfig(): PluginRuntime["modelConfig"] {
  return { ...loaderBindings.modelConfig };
}
