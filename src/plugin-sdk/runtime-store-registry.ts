type PluginRuntimeStoreSlot = { runtime: unknown };
type NamedPluginRuntimeStoreSlot = PluginRuntimeStoreSlot & {
  owners: WeakMap<object, PluginRuntimeStoreSlot>;
};
type NamedPluginRuntimeStoreRegistry = Map<string, NamedPluginRuntimeStoreSlot>;

const pluginRuntimeStoreRegistryKey = Symbol.for("openclaw.plugin-sdk.runtime-store-registry");

function getNamedPluginRuntimeStoreRegistry(): NamedPluginRuntimeStoreRegistry {
  const globalRecord = globalThis as typeof globalThis & {
    [pluginRuntimeStoreRegistryKey]?: NamedPluginRuntimeStoreRegistry;
  };
  globalRecord[pluginRuntimeStoreRegistryKey] ??= new Map();
  return globalRecord[pluginRuntimeStoreRegistryKey];
}

export function getNamedPluginRuntimeStoreSlot(key: string): NamedPluginRuntimeStoreSlot {
  const registry = getNamedPluginRuntimeStoreRegistry();
  let slot = registry.get(key);
  if (!slot) {
    slot = { runtime: null, owners: new WeakMap() };
    registry.set(key, slot);
  }
  return slot;
}

export function clearNamedPluginRuntimeStoresForTest(): void {
  const registry = getNamedPluginRuntimeStoreRegistry();
  for (const slot of registry.values()) {
    slot.runtime = null;
    slot.owners = new WeakMap();
  }
  registry.clear();
}

// Registry projections retain the exact owner without exposing runtimes in diagnostics.
const runtimeStoreOwner = Symbol.for("openclaw.pluginRuntimeStoreOwner");
type RuntimeStoreOwnerCarrier = { [runtimeStoreOwner]?: () => object };

/** Select an owner-local slot; an empty registry must never borrow another owner's runtime. */
export function getScopedPluginRuntimeStoreSlot(
  namedSlot: NamedPluginRuntimeStoreSlot,
  registry: object,
): PluginRuntimeStoreSlot {
  // SAFETY: Only this module writes the private owner carrier.
  const carrier = registry as RuntimeStoreOwnerCarrier;
  let getOwner = carrier[runtimeStoreOwner];
  if (!getOwner) {
    const owner = {};
    getOwner = () => owner;
    Object.defineProperty(registry, runtimeStoreOwner, {
      value: getOwner,
      enumerable: true,
    });
  }
  const owner = getOwner();
  let slot = namedSlot.owners.get(owner);
  if (!slot) {
    slot = { runtime: null };
    namedSlot.owners.set(owner, slot);
  }
  return slot;
}
