import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import {
  collectRegistryInvocationInstances,
  PluginInvocationScope,
} from "./plugin-invocation-scope.js";
import { markPluginRegistriesRetired } from "./registry-lifecycle.js";
import {
  PluginRegistrationResourceSource,
  type RegistrationDisposer,
  type RegistrationCleanup,
} from "./registry-registration-resources.js";
import type { PluginRegistry } from "./registry-types.js";

// Registrars and loaders can come from different source/built module copies.
const inspections = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRegistryInspectionResources"),
  () => new WeakMap<PluginRegistry, PluginRegistryInspectionResources>(),
);

export function getPluginRegistryInspectionResources(registry: PluginRegistry) {
  return inspections.get(registry);
}

function throwDisposalFailures(failures: Error[]): void {
  if (failures.length > 0) {
    throw new AggregateError(failures, "Plugin inspection resources could not all be disposed");
  }
}

/** Owns only an explicitly acquired, uncached inspection's registration resources. */
export class PluginRegistryInspectionResources {
  readonly #rollbackInstances = new Set<object>();
  readonly #source = new PluginRegistrationResourceSource(() =>
    this.retire(this.#registry, this.#rollbackInstances),
  );
  readonly #claim = this.#source.acquireClaim("inspection");
  readonly #registries = new Set<PluginRegistry>();
  readonly #dependencies = new WeakSet<PluginRegistryInspectionResources>();
  #registry?: PluginRegistry;
  #adoptedInvocations?: PluginInvocationScope;
  #release?: Promise<void>;

  constructor(
    private readonly retire: (
      registry: PluginRegistry | undefined,
      rollbackInstances: ReadonlySet<object>,
    ) => Promise<void>,
  ) {}

  attach(registry: PluginRegistry): void {
    if (this.#release) {
      throw new Error("Plugin inspection resources have been released");
    }
    // Projected views can contain borrowed donor records; physical disposal owns the source only.
    this.#registry ??= registry;
    this.#registries.add(registry);
    inspections.set(registry, this);
  }

  register(pluginId: string, disposer: RegistrationDisposer): void {
    this.#source.register(pluginId, disposer);
  }

  runRegistration(pluginId: string, run: () => void, runCleanup?: RegistrationCleanup): void {
    this.#source.runRegistration(pluginId, run, runCleanup);
  }

  trackRegistration(pending: Promise<unknown>): void {
    this.#source.trackRegistration(pending);
  }

  rollback(pluginId: string, retire?: () => Promise<void>, instance?: object): void {
    if (instance) {
      this.#rollbackInstances.add(instance);
    }
    this.#source.rollback(pluginId, retire);
  }

  /** Copied callbacks keep their source through this inspection's final disposer. */
  retainDependency(dependency: PluginRegistryInspectionResources): void {
    if (this.#release) {
      throw new Error("Plugin inspection resources have been released");
    }
    if (dependency !== this) {
      this.#source.retainDependency(() => dependency.retain());
      this.#dependencies.add(dependency);
    }
  }

  /** Adopt executable donor custody before the acquired view can escape to a caller. */
  adoptInvocations(registry: PluginRegistry, donor: PluginRegistry | undefined): void {
    if (this.#release || this.#adoptedInvocations) {
      throw new Error("Plugin inspection invocation adoption is closed");
    }
    const primaryInstances = new Set(
      this.#registry?.plugins.flatMap((record) => {
        const instance = getPluginInstance(record);
        return instance ? [instance] : [];
      }) ?? [],
    );
    const borrowed = [...collectRegistryInvocationInstances(registry)].filter(
      (instance) => !primaryInstances.has(instance),
    );
    const donorSource = donor && getPluginRegistryInspectionResources(donor);
    let physical: { release: () => Promise<void> } | undefined;
    // Install partial-acquisition custody first; failed adoption is joined by inspection release.
    this.#source.retainDependency(() => ({
      release: async () => {
        this.#adoptedInvocations?.release();
        await physical?.release();
      },
    }));
    if (donorSource && donorSource !== this) {
      physical = donorSource.retain();
      this.#dependencies.add(donorSource);
    }
    this.#adoptedInvocations = new PluginInvocationScope(registry, borrowed, { retained: true });
  }

  wrapAdoptedValue<T>(value: T): T {
    return this.#adoptedInvocations ? this.#adoptedInvocations.wrap(value) : value;
  }

  /** Logical use owns its execution consumers separately from this inspection's physical claims. */
  createInvocationScope(registry: PluginRegistry): PluginInvocationScope {
    if (this.#release) {
      throw new Error("Plugin inspection resources have been released");
    }
    return new PluginInvocationScope(registry, collectRegistryInvocationInstances(registry), {
      retained: true,
      parent: this.#adoptedInvocations,
    });
  }

  /** Recorded coverage survives retirement; retain() still checks this inspection's lifetime. */
  coversSource(source: PluginRegistryInspectionResources): boolean {
    return source === this || this.#dependencies.has(source);
  }

  /** Retains physical resources without extending this inspection's authority. */
  retain(): { release: () => Promise<void> } {
    if (this.#release) {
      throw new Error("Plugin inspection resources have been released");
    }
    const claim = this.#source.acquireClaim("borrower");
    let release: Promise<void> | undefined;
    return { release: () => (release ??= claim.release().then(throwDisposalFailures)) };
  }

  release(): Promise<void> {
    if (!this.#release) {
      // Revocation can call back into release through synchronous abort listeners.
      this.#release = this.#claim.release().then(throwDisposalFailures);
      markPluginRegistriesRetired(this.#registries);
      this.#registries.clear();
    }
    return this.#release;
  }
}
