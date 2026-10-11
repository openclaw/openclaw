import type {
  SessionEntryCurrentCheck,
  SessionEntriesCurrentCheck,
} from "../config/sessions/session-entry-current.types.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PreparedKeyedStoreOptions } from "./plugin-state-store.validation.js";

export type PluginStateOperationModule = {
  modulePath: string;
  boundaryRoot: string;
  origin: PluginOrigin;
  pluginId: string;
};

export type PluginStateOperationModuleSource = {
  resolve(moduleName: string): PluginStateOperationModule;
};

type PluginStateStoreBinding = {
  options: PreparedKeyedStoreOptions;
  assertCurrent?: () => void;
  sessionEntryCurrent?: SessionEntryCurrentCheck | SessionEntriesCurrentCheck;
  moduleSource?: PluginStateOperationModuleSource;
};

// Only async stores minted by the keyed owner can lend their admitted storage scope.
const stores = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginStateNativeBindingStores"),
  () => new WeakMap<object, PluginStateStoreBinding>(),
);

export function bindPluginStateNativeBindingStore<T extends object>(
  store: T,
  options: PreparedKeyedStoreOptions,
  assertCurrent?: () => void,
  sessionEntryCurrent?: SessionEntryCurrentCheck | SessionEntriesCurrentCheck,
  moduleSource?: PluginStateOperationModuleSource,
): T {
  stores.set(store, { options, assertCurrent, sessionEntryCurrent, moduleSource });
  return store;
}

export function capturePluginStateNativeBindingStore(store: object) {
  return stores.get(store);
}
