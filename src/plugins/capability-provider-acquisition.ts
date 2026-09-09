import type { Result } from "@openclaw/normalization-core/result";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { acquireBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import {
  preparePluginCapabilityProviderResolution,
  type CapabilityProviderFor,
} from "./capability-provider-runtime.js";
import { acquirePluginRegistryForInspection, isPluginRegistryLoadInFlight } from "./loader.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";

/** Acquires only fresh registrations; existing raw hosts keep their own custody. */
export async function acquirePluginCapabilityProviders<
  K extends Parameters<typeof preparePluginCapabilityProviderResolution>[0]["key"],
>(params: Parameters<typeof preparePluginCapabilityProviderResolution<K>>[0]) {
  const work = new AsyncWorkScope();
  const releases: Array<() => Promise<void>> = [];
  const retained = new Set<PluginRegistry>();
  const authorities = new Map<PluginRegistry, (() => boolean) | undefined>();
  const captureAuthority = (registry: PluginRegistry) => {
    if (!authorities.has(registry)) {
      authorities.set(
        registry,
        capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime: true }),
      );
    }
  };
  const dispose = () =>
    Promise.allSettled(releases.map(async (releaseClaim) => await releaseClaim())).then(
      (results) => {
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length > 0) {
          throw new AggregateError(errors, "Capability registration cleanup failed");
        }
      },
    );
  const retain = (registry: PluginRegistry | undefined) => {
    if (!registry || retained.has(registry)) {
      return;
    }
    retained.add(registry);
    captureAuthority(registry);
    const resources = getPluginRegistryInspectionResources(registry);
    if (resources) {
      releases.push(resources.retain().release);
    }
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
  try {
    const providers = await work.track(async () => {
      const resolution = preparePluginCapabilityProviderResolution(params, retain);
      let entries: PluginRegistry[K] = [];
      if (resolution.load) {
        const load = resolution.prepareLoad();
        let registry = load.loadedRegistry;
        if (!registry) {
          const loadOptions = load.resolveLoadOptions();
          if (!isPluginRegistryLoadInFlight(loadOptions)) {
            const acquired = await acquirePluginRegistryForInspection(loadOptions);
            releases.push(acquired.release);
            registry = acquired.registry;
            captureAuthority(registry);
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
    });
    return {
      providers,
      run: <T>(run: () => T | Promise<T>) =>
        releaseCompletion
          ? Promise.reject(new Error("Capability provider acquisition has been released"))
          : work.track(run),
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

async function finishCapabilityOperation<T>(
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
  run: (providers: CapabilityProviderFor<K>[]) => T | Promise<T>,
): Promise<T> {
  const acquired = await acquirePluginCapabilityProviders(params);
  let outcome: Result<T, unknown>;
  try {
    outcome = { ok: true, value: await acquired.run(() => run(acquired.providers)) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  return await finishCapabilityOperation(outcome, acquired.release);
}
