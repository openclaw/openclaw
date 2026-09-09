import type { Result } from "@openclaw/normalization-core/result";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { acquireBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import {
  preparePluginCapabilityProviderResolution,
  type CapabilityProviderFor,
} from "./capability-provider-runtime.js";
import { acquirePluginRegistryForInspection, isPluginRegistryLoadInFlight } from "./loader.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import type { PluginRegistry } from "./registry-types.js";

/** Acquires only fresh registrations; existing raw hosts keep their own custody. */
export async function withAcquiredPluginCapabilityProviders<
  K extends Parameters<typeof preparePluginCapabilityProviderResolution>[0]["key"],
  T,
>(
  params: Parameters<typeof preparePluginCapabilityProviderResolution<K>>[0],
  run: (providers: CapabilityProviderFor<K>[]) => T | Promise<T>,
): Promise<T> {
  const work = new AsyncWorkScope();
  const releases: Array<() => Promise<void>> = [];
  const retained = new Set<PluginRegistry>();
  const release = () =>
    Promise.allSettled(releases.map(async (dispose) => await dispose())).then((results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Capability registration cleanup failed");
      }
    });
  const retain = (registry: PluginRegistry | undefined) => {
    if (!registry || retained.has(registry)) {
      return;
    }
    retained.add(registry);
    const resources = getPluginRegistryInspectionResources(registry);
    if (resources) {
      releases.push(resources.retain().release);
    }
  };
  let outcome: Result<T, unknown>;
  try {
    const value = await work.track(async () => {
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
          entries = load.merge(entries, captured.registry);
        }
      }
      return await run(resolution.resolve(entries));
    });
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    work.beginClose();
    // Acquisition getters and provider callbacks share the same admitted work owner.
    await work.runWhenIdle(release);
  } catch (cleanupError) {
    outcome = {
      ok: false,
      error: outcome.ok
        ? cleanupError
        : new AggregateError(
            [outcome.error, cleanupError],
            "Capability operation and registration cleanup failed",
            { cause: outcome.error },
          ),
    };
  } finally {
    await work.drain();
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
