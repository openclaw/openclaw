import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PreparedKeyedStoreOptions } from "./plugin-state-store.validation.js";

// Only stores minted by the keyed owner can lend their admitted storage scope.
const stores = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginStateNativeBindingStores"),
  () => new WeakMap<object, { options: PreparedKeyedStoreOptions; assertCurrent?: () => void }>(),
);

export function bindPluginStateNativeBindingStore<T extends object>(
  store: T,
  options: PreparedKeyedStoreOptions,
  assertCurrent?: () => void,
): T {
  stores.set(store, { options, assertCurrent });
  return store;
}

export function capturePluginStateNativeBindingStore(store: object) {
  return stores.get(store);
}
