import type { Result } from "@openclaw/normalization-core/result";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { acquireBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import {
  preparePluginCapabilityProviderLookup,
  preparePluginCapabilityProviderResolution,
  type CapabilityProviderFor,
} from "./capability-provider-runtime.js";
import {
  acquirePluginRegistryForInspection,
  isPluginRegistryLoadInFlight,
  resolvePluginRegistryLoadCacheKey,
} from "./loader.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import {
  collectRegistryInvocationInstances,
  PluginInvocationScope,
} from "./plugin-invocation-scope.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import {
  capturePluginLifecycleAuthority,
  getPluginRegistryLifetime,
} from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";

/** Retains owned registrations while external hosts keep their own custody. */
export async function acquirePluginCapabilityProviders<
  K extends Parameters<typeof preparePluginCapabilityProviderResolution>[0]["key"],
>(
  params: Parameters<typeof preparePluginCapabilityProviderResolution<K>>[0] & {
    providerId?: string;
  },
) {
  const work = new AsyncWorkScope();
  const releases: Array<() => void | Promise<void>> = [];
  const loads = new Map<string, Promise<PluginRegistry>>();
  const retained = new Map<PluginRegistry, Map<object, PluginInvocationScope> | undefined>();
  const authorities = new Map<PluginRegistry, (() => boolean) | undefined>();
  const captureAuthority = (registry: PluginRegistry) => {
    if (!authorities.has(registry)) {
      authorities.set(
        registry,
        capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime: true }),
      );
    }
  };
  const dispose = () => {
    // Close executable views before releasing the physical claims awaiting their consumers.
    for (const invocations of retained.values()) {
      invocations?.forEach((invocation) => invocation.release());
    }
    return Promise.allSettled(releases.map(async (releaseClaim) => await releaseClaim())).then(
      (results) => {
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length > 0) {
          throw new AggregateError(errors, "Capability registration cleanup failed");
        }
      },
    );
  };
  const retain = (registry: PluginRegistry | undefined, providerId?: string) => {
    if (!registry) {
      return undefined;
    }
    const resources = getPluginRegistryInspectionResources(registry);
    if (!retained.has(registry)) {
      captureAuthority(registry);
      const release = resources?.retain().release ?? getPluginRegistryLifetime(registry)?.retain();
      if (release) {
        releases.push(release);
      }
      retained.set(registry, release ? new Map() : undefined);
    }
    const invocations = retained.get(registry);
    if (!invocations) {
      return undefined;
    }
    return (provider: CapabilityProviderFor<K>) => {
      const instance = providerId === undefined ? undefined : getPluginValueInstance(provider);
      if (providerId !== undefined && !instance) {
        return provider;
      }
      const key = instance ?? registry;
      let invocation = invocations.get(key);
      if (!invocation) {
        invocation = resources
          ? resources.createInvocationScope(registry, instance && [instance])
          : new PluginInvocationScope(
              registry,
              instance ? [instance] : collectRegistryInvocationInstances(registry),
              { retained: true },
            );
        invocations.set(key, invocation);
      }
      return invocation.wrap(provider);
    };
  };
  let releaseCompletion: Promise<void> | undefined;
  const release = () =>
    (releaseCompletion ??= Promise.resolve().then(async () => {
      work.beginClose();
      try {
        // Getters and provider callbacks may admit work beyond their direct return value.
        await work.runWhenIdle(dispose);
      } finally {
        await work.drain();
      }
    }));
  const run = <T>(operation: () => T | Promise<T>) =>
    releaseCompletion
      ? Promise.reject(new Error("Capability provider acquisition has been released"))
      : work.track(operation);
  type LoadResolution = Extract<
    ReturnType<typeof preparePluginCapabilityProviderResolution<K>>,
    { prepareLoad: () => unknown }
  >;
  const execute = async <T>(
    resolution: { resolve: (entries: PluginRegistry[K]) => T } & (
      | { load: undefined }
      | { load: LoadResolution["load"]; prepareLoad: LoadResolution["prepareLoad"] }
    ),
  ): Promise<T> => {
    let entries: PluginRegistry[K] = [];
    if (resolution.load) {
      const load = resolution.prepareLoad();
      let registry = load.loadedRegistry;
      if (!registry) {
        const loadOptions = load.resolveLoadOptions();
        if (!isPluginRegistryLoadInFlight(loadOptions)) {
          const key = resolvePluginRegistryLoadCacheKey(loadOptions);
          let pending = loads.get(key);
          if (!pending) {
            pending = acquirePluginRegistryForInspection(loadOptions).then((acquired) => {
              releases.push(acquired.release);
              captureAuthority(acquired.registry);
              return acquired.registry;
            });
            loads.set(key, pending);
          }
          registry = await pending;
        }
      }
      const fallback = load.fallback(registry);
      entries = fallback.entries;
      if (fallback.pluginIds.length > 0) {
        const captured = await acquireBundledCapabilityRuntimeRegistry({
          ...resolution.load.loadOptions,
          pluginIds: fallback.pluginIds,
        });
        releases.push(captured.release);
        captureAuthority(captured.registry);
        entries = load.merge(entries, captured.registry);
      }
    }
    return resolution.resolve(entries);
  };
  const resolveProviders = (
    query: Omit<Parameters<typeof preparePluginCapabilityProviderResolution<K>>[0], "key">,
  ) =>
    run(() =>
      execute<CapabilityProviderFor<K>[]>(
        preparePluginCapabilityProviderResolution({ ...query, key: params.key }, retain),
      ),
    );
  const resolveProvider = (
    query: Omit<Parameters<typeof preparePluginCapabilityProviderLookup<K>>[0], "key">,
  ) =>
    run(() =>
      execute<CapabilityProviderFor<K> | undefined>(
        preparePluginCapabilityProviderLookup({ ...query, key: params.key }, (registry) =>
          retain(registry, query.providerId),
        ),
      ),
    );
  try {
    const providers =
      params.providerId === undefined
        ? await resolveProviders(params)
        : [await resolveProvider({ providerId: params.providerId, cfg: params.cfg })].filter(
            (provider) => provider !== undefined,
          );
    return {
      providers,
      run,
      resolveProviders,
      resolveProvider,
      assertOpen: () => {
        if (releaseCompletion || [...authorities.values()].some((isCurrent) => !isCurrent?.())) {
          throw new Error(
            "The provider setup changed while preparing this request. Retry with the current provider setup.",
          );
        }
      },
      release,
    };
  } catch (error) {
    return await finishCapabilityOperation<never>({ ok: false, error }, release);
  }
}

export async function finishCapabilityOperation<T>(
  outcome: Result<T, unknown>,
  release: () => Promise<void>,
): Promise<T> {
  let result = outcome;
  try {
    await release();
  } catch (cleanupError) {
    result = {
      ok: false,
      error: outcome.ok
        ? cleanupError
        : new AggregateError(
            [outcome.error, cleanupError],
            "Capability operation and registration cleanup failed",
            { cause: outcome.error },
          ),
    };
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Keeps callback-shaped operations on the same acquisition and actual-work owner. */
export async function withAcquiredPluginCapabilityProviders<
  K extends Parameters<typeof preparePluginCapabilityProviderResolution>[0]["key"],
  T,
>(
  params: Parameters<typeof preparePluginCapabilityProviderResolution<K>>[0],
  run: (
    providers: CapabilityProviderFor<K>[],
    queries: Pick<
      Awaited<ReturnType<typeof acquirePluginCapabilityProviders<K>>>,
      "resolveProvider" | "resolveProviders"
    >,
  ) => T | Promise<T>,
): Promise<T> {
  const acquired = await acquirePluginCapabilityProviders(params);
  let outcome: Result<T, unknown>;
  try {
    outcome = { ok: true, value: await acquired.run(() => run(acquired.providers, acquired)) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  return await finishCapabilityOperation(outcome, acquired.release);
}
