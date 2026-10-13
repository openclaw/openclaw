/** Native composition entry for ordinary, restricted, and cold provider-hook loading. */
import { setImmediate as nextTurn } from "node:timers/promises";
import { createExternalAuthRuntime } from "../agents/auth-profiles/external-auth.js";
import { withLegacyExternalAuthPreparation } from "../agents/auth-profiles/external-auth.native.js";
import { createAuthProfileStoreRuntime } from "../agents/auth-profiles/store.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { resolveAllowedModelRefCore } from "../agents/model-selection-resolve.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createPluginCapabilityCatalogContext } from "./capability-catalog-context.js";
import { preparePluginMetadataMachineStateAsync } from "./installed-plugin-index-record-state.js";
import { isPluginRegistryCacheEnabled, isPluginRegistryLoadInFlight } from "./loader-cache.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import {
  loadOpenClawPluginsCore,
  loadOpenClawPluginsSteps,
  type InternalPluginLoadOverrides,
  type NativePluginLoadBindings,
} from "./loader-runtime-core.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  createPluginCache,
  getPluginCache,
  releasePluginCacheInstance,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { PluginInstanceDrainTimeoutError } from "./plugin-instance-error.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { inheritPluginNativeAdmissions } from "./plugin-native-admission-state.js";
import { createProviderAuthAvailability } from "./provider-auth-availability-core.js";
import { createProviderExternalAuthResolver } from "./provider-external-auth-core.js";
import { createProviderHookRuntime } from "./provider-hook-runtime-core.js";
import { createProviderRegistryResolver } from "./providers.runtime-core.js";
import { PluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import type { PluginRegistry } from "./registry-types.js";
import { PluginRuntimeCloseRetainedError } from "./runtime-close-error.js";
import { createRuntimeModelAuth } from "./runtime/runtime-model-auth.js";
import type { PluginRuntime } from "./runtime/types.js";

// Construction only binds callbacks. No profile reads, plugin loads, or network work occur here.
// Hoisted entry functions let cold auth discovery re-enter this same binding without a module cycle.
const providerRegistry = Object.freeze(
  createProviderRegistryResolver({
    loadOpenClawPluginsAsync,
    isPluginRegistryLoadInFlight,
  }),
);
const providerHooks = Object.freeze(createProviderHookRuntime(providerRegistry));
const externalProfiles = Object.freeze(createProviderExternalAuthResolver(providerHooks));
const legacyExternalProfiles = createProviderExternalAuthResolver({
  resolveProviderPluginsForHooks: (params) =>
    providerRegistry.resolveLegacyPluginProvidersCore(
      { ...params, activate: false, skipIfLoadInFlight: true },
      loadOpenClawPlugins,
    ),
  resolveProviderPluginsForHooksAsync: providerHooks.resolveProviderPluginsForHooksAsync,
});
const externalAuth = Object.freeze(
  withLegacyExternalAuthPreparation(
    createExternalAuthRuntime(
      legacyExternalProfiles.resolveExternalAuthProfilesWithPlugins,
      externalProfiles.prepareExternalAuthProfilesWithPlugins,
    ),
  ),
);
const authStore = Object.freeze(createAuthProfileStoreRuntime(externalAuth));
const authAvailability = Object.freeze(createProviderAuthAvailability(authStore));
let modelAuth: NativePluginLoadBindings["modelAuth"] | undefined;
let modelConfig: NativePluginLoadBindings["modelConfig"] | undefined;
let capabilityCatalogContext: NativePluginLoadBindings["capabilityCatalogContext"] | undefined;
// Imports of store/hook facades must not construct unrelated policy surfaces.
// Consumers share immutable defaults and retain their own mutable method views.
const loaderBindings: NativePluginLoadBindings = Object.freeze({
  get modelAuth() {
    return (modelAuth ??= Object.freeze(
      createRuntimeModelAuth({
        ensureAuthProfileStore: authStore.ensureAuthProfileStore,
        ensureAuthProfileStoreAsync: authStore.ensureAuthProfileStoreAsync,
        isProviderApiKeyConfigured: authAvailability.isProviderApiKeyConfigured,
        isProviderApiKeyConfiguredAsync: authAvailability.isProviderApiKeyConfiguredAsync,
      }),
    ));
  },
  get modelConfig() {
    return (modelConfig ??= Object.freeze({
      resolveDefaultModelForAgent,
      resolveAllowedModelRef: resolveAllowedModelRefCore,
      resolveModelRuntimePolicy,
    }));
  },
  get capabilityCatalogContext() {
    return (capabilityCatalogContext ??= createPluginCapabilityCatalogContext(authAvailability));
  },
});

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

/** Keep network callbacks responsive without publishing a partially registered generation. */
export async function loadOpenClawPluginsAsync(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const preparedOptions = {
    ...options,
    env: cloneEnvWithPlatformSemantics(options.env ?? process.env),
  };
  await preparePluginMetadataMachineStateAsync({ env: preparedOptions.env });
  const load = async () => {
    const steps = loadOpenClawPluginsSteps(preparedOptions, loaderBindings);
    let step = steps.next();
    while (!step.done) {
      await nextTurn();
      step = steps.next();
    }
    return step.value;
  };
  if (
    preparedOptions.previousRegistry ||
    preparedOptions.borrowRegistry ||
    preparedOptions.moduleRecoveries ||
    !isPluginRegistryCacheEnabled(preparedOptions)
  ) {
    return await load();
  }
  const context = resolvePluginLoadCacheContext(preparedOptions);
  return await context.cacheState.loadAsync(context.cacheKey, load);
}

/** Publishes synchronously, then joins every accepted health write before returning to its host. */
export async function loadAndActivateRootPluginRegistry(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const preparedOptions = {
    ...options,
    env: cloneEnvWithPlatformSemantics(options.env ?? process.env),
  };
  await preparePluginMetadataMachineStateAsync({ env: preparedOptions.env });
  const cleanup: Promise<void>[] = [];
  try {
    return loadOpenClawPluginsCore(
      { ...preparedOptions, activate: true },
      loaderBindings,
      undefined,
      undefined,
      (completion) => cleanup.push(completion),
    );
  } finally {
    await Promise.allSettled(cleanup);
  }
}

/** Acquires a fresh discovery registry; release waits for its registration resources. */
export async function acquirePluginRegistryForInspection(
  options: Omit<PluginLoadOptions, "activate" | "cache"> = {},
): Promise<{ registry: PluginRegistry; release: () => Promise<void> }> {
  const preparedOptions = {
    ...options,
    env: cloneEnvWithPlatformSemantics(options.env ?? process.env),
  };
  return acquireRegistryResources(async (resources) => {
    await preparePluginMetadataMachineStateAsync({ env: preparedOptions.env });
    return loadOpenClawPluginsCore(
      { ...preparedOptions, activate: false, cache: false },
      loaderBindings,
      undefined,
      resources,
    );
  });
}

async function acquireRegistryResources(
  load: (resources: PluginRegistryInspectionResources) => PluginRegistry | Promise<PluginRegistry>,
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
    // Rollback completions were already consumed by the collector before this finalizer.
    const results = await Promise.allSettled(
      [...instances]
        .filter((instance) => !rollbackInstances.has(instance))
        .map((instance) => instance.dispose()),
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
      const retired = await retirePluginCache(cache);
      failures.push(...retired.failures.map((failure) => failure.error));
    } catch (reason) {
      failures.push(new PluginRuntimeCloseRetainedError(reason));
    }
    if (failures.length) {
      const error = new AggregateError(failures, "Plugin inspection instances failed to retire");
      // Settled callback faults are diagnostics; timed-out disposal still owns physical cleanup.
      throw failures.some((failure) => failure instanceof PluginInstanceDrainTimeoutError)
        ? new PluginRuntimeCloseRetainedError(error)
        : error;
    }
  });
  try {
    inheritPluginNativeAdmissions(getPluginCache(), cache);
    const registry = await withPluginCache(cache, () => load(resources));
    return { registry, release: () => resources.release() };
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
  return loadRegistryWithInternalOverrides(options, overrides);
}

/** Owns the same narrow capability runtime without publishing or caching its registrations. */
export function acquirePluginRegistryWithInternalOverrides(
  options: PluginLoadOptions & { cache: false; activate: false },
  overrides: ScopedRuntimeOverrides,
): Promise<{ registry: PluginRegistry; release: () => Promise<void> }> {
  const preparedOptions = {
    ...options,
    env: cloneEnvWithPlatformSemantics(options.env ?? process.env),
  };
  return acquireRegistryResources(async (resources) => {
    await preparePluginMetadataMachineStateAsync({ env: preparedOptions.env });
    return loadRegistryWithInternalOverrides(preparedOptions, overrides, resources);
  });
}

function loadRegistryWithInternalOverrides(
  options: PluginLoadOptions & { cache: false },
  overrides: ScopedRuntimeOverrides,
  resources?: PluginRegistryInspectionResources,
): PluginRegistry {
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
  return loadOpenClawPluginsCore(options, loaderBindings, { ...overrides, runtime }, resources);
}

export function resolveNativePluginModelAuth(): PluginRuntime["modelAuth"] {
  return { ...loaderBindings.modelAuth };
}
export function resolveNativePluginModelConfig(): PluginRuntime["modelConfig"] {
  return { ...loaderBindings.modelConfig };
}
