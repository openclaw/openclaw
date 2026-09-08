import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import {
  PluginRegistrationResourceSource,
  type RegistrationDisposer,
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
  readonly #source = new PluginRegistrationResourceSource();
  readonly #claim = this.#source.acquireClaim("inspection");
  #registry?: PluginRegistry;
  #release?: Promise<void>;

  attach(registry: PluginRegistry): void {
    this.#registry = registry;
    inspections.set(registry, this);
  }

  register(pluginId: string, disposer: RegistrationDisposer): void {
    this.#source.register(pluginId, disposer);
  }

  trackRegistration(pending: Promise<unknown>): void {
    this.#source.trackRegistration(pending);
  }

  rollback(pluginId: string): void {
    this.#source.rollback(pluginId);
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
      if (this.#registry) {
        markPluginRegistryRetired(this.#registry);
      }
    }
    return this.#release;
  }
}
