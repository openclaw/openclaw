/** Tracks active and retired plugin registries so stale runtime calls can be rejected. */
import type { PluginRegistry } from "./registry-types.js";

const retiredRegistries = new WeakSet<PluginRegistry>();
const activatedRegistries = new WeakSet<PluginRegistry>();
const activeFinalToolInputPolicies = new WeakMap<
  object,
  PluginRegistry["finalToolInputPolicies"]
>();

function sealFinalToolInputPolicies(registry: PluginRegistry): void {
  if (activeFinalToolInputPolicies.has(registry)) {
    return;
  }
  const sealedPolicies = Object.freeze(
    registry.finalToolInputPolicies.map((registration) =>
      Object.freeze({
        ...registration,
        policy: Object.freeze({ ...registration.policy }),
      }),
    ),
  ) as unknown as PluginRegistry["finalToolInputPolicies"];
  activeFinalToolInputPolicies.set(registry, sealedPolicies);
  // Keep the visible array read-only while remaining compatible with registry
  // forwarding proxies. Enforcement reads the private snapshot below, so even
  // a configurable proxy descriptor cannot remove the live veto layer.
  try {
    Reflect.defineProperty(registry, "finalToolInputPolicies", {
      configurable: true,
      enumerable: true,
      value: sealedPolicies,
      writable: false,
    });
  } catch {
    // A forwarding proxy may reject descriptor changes; the private snapshot still enforces.
  }
}

/** Returns the immutable policy snapshot captured when a registry became live. */
export function getActivatedFinalToolInputPolicies(
  registry: object,
): PluginRegistry["finalToolInputPolicies"] | undefined {
  return activeFinalToolInputPolicies.get(registry);
}

/** Marks a registry retired so late runtime calls can reject stale plugin state. */
export function markPluginRegistryRetired(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    retiredRegistries.add(registry);
  }
}

/** Marks a registry active and clears any previous retired state. */
export function markPluginRegistryActive(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    sealFinalToolInputPolicies(registry);
    activatedRegistries.add(registry);
    retiredRegistries.delete(registry);
  }
}

/** True when a registry has been activated for runtime use. */
export function isPluginRegistryActivated(registry: PluginRegistry): boolean {
  return activatedRegistries.has(registry);
}

/** True when a registry has been retired by a newer active registry. */
export function isPluginRegistryRetired(registry: PluginRegistry): boolean {
  return retiredRegistries.has(registry);
}
