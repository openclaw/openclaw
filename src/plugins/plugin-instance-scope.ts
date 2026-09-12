import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import type {
  PluginInvocationInstance,
  PluginInstanceResource,
  PluginInstanceConsumer,
  PluginInstanceDisposalResult,
  PluginInstanceExecution,
} from "./plugin-instance.types.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";

/** Runtime consumers retain capabilities, never the concrete loader implementation. */
export interface PluginInstanceHandle extends PluginInvocationInstance, PluginInstanceExecution {
  readonly disposing: boolean;
  readonly hasActiveCall: boolean;
  readonly acceptingCalls: boolean;
  readonly hasRetainedConsumers: boolean;
  readonly owner?: PluginInstanceOwner;
  toolRegistrationComplete: boolean;
  runConsumer<T>(consume: () => T): T;
  adopt<T>(value: T): T;
  retainConsumer(
    invoke?: <T>(run: () => T) => T,
    registry?: PluginRegistry,
  ): PluginInstanceConsumer;
  runInRegistry<T>(registry: PluginRegistry, run: () => T): T;
  createRegistryView(registry: PluginRegistry, invoke: <T>(run: () => T) => T): <T>(value: T) => T;
  drain(): Promise<PluginInstanceDisposalResult>;
  resume(): void;
}

export type PluginInvocationBinding = {
  run: <T>(run: () => T) => T;
  wrap: <T>(value: T) => T;
};

export type PluginInvocationContext = {
  lookup: (instance: PluginInstanceHandle) => PluginInvocationBinding | undefined;
};

export type PluginInstanceOwner = {
  record: PluginRecord;
  registry: PluginRegistry;
  revoked: boolean;
  instance?: PluginInstanceHandle;
};
// SDK source transforms and native core chunks must observe the same exact owner.
export const pluginInstanceState = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstanceState"),
  () => ({
    records: new WeakMap<PluginRecord | PluginInstanceResource, PluginInstanceOwner>(),
    values: new WeakMap<object, PluginInstanceHandle>(),
  }),
);

export const pluginInvocationContext = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInvocationContext"),
  () => new AsyncLocalStorage<PluginInvocationContext>(),
);

export function resolvePluginInstanceOwner(record: PluginRecord, registry: PluginRegistry) {
  let owner = pluginInstanceState.records.get(record);
  if (!owner) {
    owner = { record, registry, revoked: false };
    pluginInstanceState.records.set(record, owner);
  }
  return owner;
}

/** Record and resource keys resolve the same owner through adoption and failed registration. */
export function getPluginInstanceOwner(
  instance: PluginInstanceResource,
): PluginInstanceOwner | undefined {
  return pluginInstanceState.records.get(instance);
}

/** Direct SDK registrars retain the same owner as registrations made through api. */
export function wrapCurrentPluginInstance<T>(value: T, host?: (value: T) => T): T {
  const owner = pluginInstanceInvocation.getStore()?.instance;
  return owner ? owner.wrap(value) : host ? host(value) : value;
}

/** Teardown admission comes from the host owner, never a plugin method name. */
export function runPluginCleanup<T>(value: object, run: () => T): T {
  const instance = pluginInstanceState.values.get(value);
  return instance ? instance.runCleanup(run) : run();
}

/** Named SDK slots share only within the exact managed plugin instance. */
export function getPluginInstanceRuntimeSlot(
  key: string | symbol,
): { runtime: unknown } | undefined {
  const owner = pluginInstanceInvocation.getStore()?.instance;
  if (!owner) {
    return undefined;
  }
  let slot = owner.slots.get(key);
  if (!slot) {
    owner.slots.set(key, (slot = { runtime: null }));
  }
  return slot;
}

export function getPluginInstance(record: PluginRecord): PluginInstanceHandle | undefined {
  return pluginInstanceState.records.get(record)?.instance;
}

/** Exact owner of a callable public view; never inferred from a plugin id or path. */
export function getPluginValueInstance(value: object): PluginInstanceHandle | undefined {
  return pluginInstanceState.values.get(value);
}

/** Host consumers retain the exact stream owner until their terminal work settles. */
export function runPluginStreamConsumer<T>(stream: object, consume: () => T): T {
  const instance = getPluginValueInstance(stream);
  return instance ? instance.runConsumer(consume) : consume();
}
