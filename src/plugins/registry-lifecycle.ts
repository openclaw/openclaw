/** Registry handles expire at publication; unchanged plugin instances retain their own authority. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PluginLoaderCacheState } from "./loader-cache-state.js";
import { getPluginCache, type PluginCache } from "./plugin-cache.js";
import {
  getPluginInstance,
  getPluginInstanceOwner,
  pluginInstanceState,
  resolvePluginInstanceOwner,
} from "./plugin-instance-scope.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import { getPluginRegistryState } from "./runtime-state.js";

type PluginRegistryLifecycleState = {
  // The 2026.9.1 updater retains opaque epoch objects without a controller.
  epoch?: PluginRegistryLifecycleEpoch;
  controller?: AbortController;
};

type PluginRegistryLifecycleStore = {
  retiredRegistries: WeakSet<PluginRegistry>;
  activatedRegistries: WeakSet<PluginRegistry>;
  registryEpochs: WeakMap<PluginRegistry, PluginRegistryLifecycleState>;
  preparation?: AsyncLocalStorage<{ registry: PluginRegistry; active: boolean }>;
  loaderCaches?: WeakMap<PluginRegistry, Set<PluginLoaderCacheState<PluginRegistry>>>;
  registryLoads?: WeakMap<PluginCache, PluginLoaderCacheState<PluginRegistry>>;
  registryResourceOwners?: WeakMap<PluginRegistry, PluginRegistry>;
};

const lifecycle = resolveGlobalSingleton<PluginRegistryLifecycleStore>(
  Symbol.for("openclaw.pluginRegistryLifecycle"),
  () => ({
    retiredRegistries: new WeakSet(),
    activatedRegistries: new WeakSet(),
    registryEpochs: new WeakMap(),
  }),
);
const { retiredRegistries, activatedRegistries, registryEpochs } = lifecycle;
// Released updaters can load this module after swapping package bytes in the same process.
// Add new ownership fields once, preserving the maps and sets their captured callbacks use.
const preparation = (lifecycle.preparation ??= new AsyncLocalStorage());
const loaderCaches = (lifecycle.loaderCaches ??= new WeakMap());
const registryLoads = (lifecycle.registryLoads ??= new WeakMap());
const registryResourceOwners = (lifecycle.registryResourceOwners ??= new WeakMap());

/** Projection changes contributions, not custody of the loaded instances. */
export function bindPluginRegistryResourceOwner(
  view: PluginRegistry,
  source: PluginRegistry,
): PluginRegistry {
  const owner = getPluginRegistryResourceOwner(source);
  if (view !== owner) {
    registryResourceOwners.set(view, owner);
  }
  return view;
}

export function getPluginRegistryResourceOwner(registry: PluginRegistry): PluginRegistry {
  return registryResourceOwners.get(registry) ?? registry;
}

export function getPluginLoaderCacheState(cache = getPluginCache()) {
  const cached = registryLoads.get(cache);
  if (cached) {
    return cached;
  }
  const loads = new PluginLoaderCacheState<PluginRegistry>(128, (registry) => {
    let owners = loaderCaches.get(registry);
    if (!owners) {
      loaderCaches.set(registry, (owners = new Set()));
    }
    owners.add(loads);
    for (const record of registry.plugins) {
      const instance = getPluginInstance(record);
      if (instance) {
        cache.instances.add(instance);
      }
    }
  });
  registryLoads.set(cache, loads);
  cache.retireRegistryLoads = async () => {
    loads.clearCachedRegistries();
    const registries = new Set<PluginRegistry>();
    for (const instance of cache.instances) {
      const owner = getPluginInstanceOwner(instance);
      if (!owner) {
        continue;
      }
      // Publication transfers exact instances to their runtime owner, including adopted records.
      if (isPluginRecordActive(owner.registry, owner.record)) {
        cache.instances.delete(instance);
      } else if (registryEpochs.get(owner.registry)?.epoch === undefined) {
        instance.quiesce();
        registries.add(owner.registry);
      }
    }
    for (const registry of registries) {
      quiescePluginRegistry(registry);
    }
    if (registries.size === 0) {
      return { cleanupCount: 0, failures: [] };
    }
    // Lookup invalidation never reaches this terminal owner; runtime cleanup stays lazy until retirement.
    const { disposePluginRegistryInstances } = await import("./runtime.js");
    const results = await Promise.allSettled(
      [...registries].map((registry) => disposePluginRegistryInstances(registry)),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "Plugin cached registry cleanup failed");
    }
    const completed = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    return {
      cleanupCount: completed.reduce((count, result) => count + result.cleanupCount, 0),
      failures: completed.flatMap((result) => result.failures),
    };
  };
  return loads;
}

export type PluginRegistryLifecycleEpoch = object;

/** Transfer exact instances at publication without reviving a removed or failed instance. */
export function adoptPluginRegistryRecords(registryView: PluginRegistry | null | undefined): void {
  const registry = registryView && getPluginRegistryResourceOwner(registryView);
  if (!registry || retiredRegistries.has(registry)) {
    return;
  }
  for (const record of registry.plugins) {
    const owner = resolvePluginInstanceOwner(record, registry);
    if (!owner.revoked) {
      owner.registry = registry;
    }
  }
}

function closePluginRegistryAdmissions(
  registries: Iterable<PluginRegistry>,
  revokeRecords: boolean,
): void {
  const instances = new Set<NonNullable<ReturnType<typeof getPluginInstance>>>();
  const controllers: AbortController[] = [];
  for (const registryView of registries) {
    const registry = getPluginRegistryResourceOwner(registryView);
    const previous = registryEpochs.get(registry);
    retiredRegistries.add(registry);
    registryEpochs.delete(registry);
    if (previous?.controller) {
      controllers.push(previous.controller);
    }
    for (const record of registry.plugins) {
      const owner = resolvePluginInstanceOwner(record, registry);
      if (owner.registry === registry) {
        if (revokeRecords || !owner.instance) {
          owner.revoked = true;
        }
        if (owner.instance) {
          instances.add(owner.instance);
        }
      }
    }
    // Match the retired value across birth caches; a reused key may hold its successor.
    for (const cache of loaderCaches.get(registry) ?? []) {
      cache.deleteValue(registry);
    }
    loaderCaches.delete(registry);
  }
  // Close every view before instance or registry abort listeners can reenter a sibling.
  for (const instance of instances) {
    instance.quiesce();
  }
  for (const controller of controllers) {
    controller.abort();
  }
}

/** Close new admission while the existing command owner joins admitted work. */
export function quiescePluginRegistry(registry: PluginRegistry | null | undefined): void {
  closePluginRegistryAdmissions(registry ? [registry] : [], false);
}

export function markPluginRegistryRetired(registry: PluginRegistry | null | undefined): void {
  closePluginRegistryAdmissions(registry ? [registry] : [], true);
}

/** Revoke all attached inspection views before any abort callback observes retirement. */
export function markPluginRegistriesRetired(registries: Iterable<PluginRegistry>): void {
  closePluginRegistryAdmissions(registries, true);
}

export function markPluginRegistryActive(registryView: PluginRegistry | null | undefined): void {
  if (!registryView) {
    return;
  }
  const registry = getPluginRegistryResourceOwner(registryView);
  const previous = registryEpochs.get(registry);
  activatedRegistries.add(registry);
  retiredRegistries.delete(registry);
  registryEpochs.set(registry, { epoch: Object.freeze({}), controller: new AbortController() });
  adoptPluginRegistryRecords(registry);
  previous?.controller?.abort();
}

export function capturePluginRegistryLifecycleEpoch(
  registryView: PluginRegistry,
): PluginRegistryLifecycleEpoch | undefined {
  const registry = getPluginRegistryResourceOwner(registryView);
  return retiredRegistries.has(registry) ? undefined : registryEpochs.get(registry)?.epoch;
}

/** Observe an exact active epoch or explicitly scoped handle without granting activation. */
export function capturePluginRegistryLifecycleSignal(
  registryView: PluginRegistry,
  epoch: PluginRegistryLifecycleEpoch | undefined,
  options?: { scopedRuntime?: boolean },
): AbortSignal | undefined {
  const registry = getPluginRegistryResourceOwner(registryView);
  let current = registryEpochs.get(registry);
  if (
    retiredRegistries.has(registry) ||
    (epoch === undefined && options?.scopedRuntime !== true) ||
    current?.epoch !== epoch
  ) {
    return undefined;
  }
  if (!current) {
    // Scoped loader handles are live without root activation. Their existing undefined
    // epoch remains unchanged until retirement or the first real activation.
    current = { epoch: undefined, controller: new AbortController() };
    registryEpochs.set(registry, current);
  }
  return current.controller?.signal;
}

/** True only while the exact captured registry activation remains current. */
export function isPluginRegistryLifecycleEpochActive(
  registryView: PluginRegistry,
  epoch: PluginRegistryLifecycleEpoch,
): boolean {
  const registry = getPluginRegistryResourceOwner(registryView);
  return !retiredRegistries.has(registry) && registryEpochs.get(registry)?.epoch === epoch;
}

/** Resolve current contributions for a retained instance instead of its retired birth registry. */
export function getPluginRecordRegistry(
  registry: PluginRegistry,
  record: PluginRecord,
): PluginRegistry {
  return getPluginRegistryResourceOwner(
    pluginInstanceState.records.get(record)?.registry ?? registry,
  );
}

export function isPluginRecordActive(registry: PluginRegistry, record: PluginRecord): boolean {
  const owner = getPluginRecordRegistry(registry, record);
  return (
    !pluginInstanceState.records.get(record)?.revoked &&
    getPluginInstance(record)?.acceptingCalls !== false &&
    registryEpochs.get(owner)?.epoch !== undefined &&
    owner.plugins.includes(record) &&
    record.enabled &&
    record.status === "loaded"
  );
}

export function revokePluginRecord(registry: PluginRegistry, record: PluginRecord): void {
  resolvePluginInstanceOwner(record, registry).revoked = true;
}

export function isPluginRegistryPreparing(registryView: PluginRegistry): boolean {
  const registry = getPluginRegistryResourceOwner(registryView);
  const scope = preparation.getStore();
  return scope?.active === true && scope.registry === registry && !retiredRegistries.has(registry);
}

/** Replacement registration and services share bounded authority before publication. */
export function withPluginRegistryPreparationScope<T>(
  registryView: PluginRegistry,
  run: () => T,
): T {
  const registry = getPluginRegistryResourceOwner(registryView);
  if (retiredRegistries.has(registry)) {
    throw new Error("Cannot prepare a retired plugin registry");
  }
  const scope = { registry, active: true };
  return preparation.run(scope, () => {
    let pending = false;
    try {
      const result = run();
      if (isPromiseLike(result)) {
        pending = true;
        return Promise.resolve(result).finally(() => {
          scope.active = false;
        }) as T; // SAFETY: Preserves the callback's resolved value and async shape.
      }
      return result;
    } finally {
      if (!pending) {
        scope.active = false;
      }
    }
  });
}

/** True after any runtime activation, including a generation retired during publication. */
export function isPluginRegistryActivated(registryView: PluginRegistry): boolean {
  return activatedRegistries.has(getPluginRegistryResourceOwner(registryView));
}

export function isPluginRegistryRetired(registryView: PluginRegistry): boolean {
  const registry = getPluginRegistryResourceOwner(registryView);
  return retiredRegistries.has(registry);
}

export function capturePluginLifecycleAuthority(
  registryView: PluginRegistry,
  record?: PluginRecord,
  options?: { scopedRuntime?: boolean; registration?: boolean; admittedRuntime?: boolean },
): (() => boolean) | undefined {
  const registry = getPluginRegistryResourceOwner(registryView);
  if (record) {
    const owner = resolvePluginInstanceOwner(record, registry);
    const usable = () => {
      const registration = options?.registration
        ? getPluginRegistryState()?.registrationContext
        : undefined;
      return (
        !owner.revoked &&
        record.enabled &&
        record.status === "loaded" &&
        ((options?.admittedRuntime === true &&
          owner.registry.plugins.includes(record) &&
          owner.instance?.hasActiveCall === true) ||
          isPluginRecordActive(registry, record) ||
          (isPluginRegistryPreparing(registry) && registry.plugins.includes(record)) ||
          // Synchronous registration owns calls before its completed record enters the registry.
          (registration?.registry === registry &&
            registration.pluginId === record.id &&
            registration.instance === owner.instance &&
            owner.instance?.hasActiveCall === true) ||
          (options?.scopedRuntime === true &&
            registryEpochs.get(registry)?.epoch === undefined &&
            !retiredRegistries.has(registry) &&
            registry.plugins.includes(record)))
      );
    };
    // Mint only from the current owner; retained closures follow legitimate adoption.
    return owner.registry === registry && usable() ? usable : undefined;
  }
  const epoch = registryEpochs.get(registry)?.epoch;
  if ((!epoch && !options?.scopedRuntime) || retiredRegistries.has(registry)) {
    return undefined;
  }
  return () => registryEpochs.get(registry)?.epoch === epoch && !retiredRegistries.has(registry);
}
