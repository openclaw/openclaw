import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { createPluginValueInstances } from "./plugin-instance-owned-values.js";
import type {
  PluginInvocationInstance,
  PluginInstanceResource,
  PluginInstanceConsumer,
  PluginInstanceDisposalResult,
  PluginInstanceExecution,
  PluginRetentionSnapshot,
  PluginRetentionReason,
  PluginRetentionOwner,
  PluginWorkRelease,
} from "./plugin-instance.types.js";
import type { PluginReplacementOperation } from "./plugin-replacement-operation.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";

export type PluginInstanceCall = {
  registry?: PluginRegistry;
  cleanup: boolean;
  ownerJoined: boolean;
  ownerLifetime?: true;
};

export type PluginInstanceConsumerState = {
  active: boolean;
  registry?: PluginRegistry;
  kind: "work" | "custody";
};

/** Runtime consumers retain capabilities, never the concrete loader implementation. */
export interface PluginInstanceHandle extends PluginInvocationInstance, PluginInstanceExecution {
  readonly disposing: boolean;
  readonly acceptingCalls: boolean;
  readonly replacementPending: boolean;
  readonly hasRetainedConsumers: boolean;
  readonly owner?: PluginInstanceOwner;
  toolRegistrationComplete: boolean;
  runConsumer<T>(consume: () => T): T;
  retainOwnerWork(): { run<T>(run: () => T): T; release(this: void): void };
  adopt<T>(value: T): T;
  admitFactory(
    factory: (...args: never[]) => unknown,
    resultCallbacks?: "tool" | readonly PropertyKey[],
  ): void;
  retainWork(reason?: PluginRetentionReason): PluginWorkRelease;
  retentionSnapshot(options?: { limit?: number; includeOwners?: boolean }): PluginRetentionSnapshot;
  readonly retainedWorkCount: number;
  readonly ordinaryCallCount: number;
  readonly admittedWorkCount: number;
  waitForAdmittedWork(signal: AbortSignal): Promise<void>;
  waitForRetainedWork(
    signal: AbortSignal,
    options?: { includeConsumers?: boolean; includeCalls?: boolean },
  ): Promise<void>;
  waitForIdle(signal: AbortSignal): Promise<void>;
  reserveReplacement(operation?: PluginReplacementOperation): () => void;
  retainConsumer(
    invoke?: <T>(run: () => T) => T,
    registry?: PluginRegistry,
    kind?: "work" | "custody",
    diagnostics?: { reason?: PluginRetentionReason; owner?: PluginRetentionOwner },
  ): PluginInstanceConsumer;
  runInRegistry<T>(
    registry: PluginRegistry | undefined,
    run: () => T,
    options?: { joinDisposal?: boolean },
  ): T;
  createRegistryView(registry: PluginRegistry, invoke: <T>(run: () => T) => T): <T>(value: T) => T;
  drain(options?: {
    includeConsumers?: boolean;
    signal?: AbortSignal;
  }): Promise<PluginInstanceDisposalResult>;
  resume(): void;
}

export type PluginInvocationBinding = {
  run: <T>(run: () => T) => T;
  wrap: <T>(value: T) => T;
};

export type PluginInvocationContext = {
  readonly holdsPendingReplacement?: boolean;
  readonly pendingReplacementInstances?: readonly PluginInstanceHandle[];
  lookup: (instance: PluginInstanceHandle) => PluginInvocationBinding | undefined;
};

export type PluginInstanceOwner = {
  record: PluginRecord;
  instance?: PluginInstanceHandle;
  incarnationId?: string;
} & (
  | { revoked: false; registry: PluginRegistry }
  | { revoked: true; registry: PluginRegistry | undefined }
);
// SDK source transforms and native core chunks must observe the same exact owner.
export const pluginInstanceState = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstanceState"),
  () => ({
    records: new WeakMap<PluginRecord | PluginInstanceResource, PluginInstanceOwner>(),
    values: createPluginValueInstances<PluginInstanceHandle>(),
  }),
);

export const pluginInvocationContext = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInvocationContext"),
  () => new AsyncLocalStorage<PluginInvocationContext>(),
);

/** Compatibility query for callers holding a published plugin invocation context. */
export function currentPluginWorkHoldsPendingReplacement(): boolean {
  return (
    currentPluginWorkPendingReplacements().length > 0 ||
    pluginInvocationContext.getStore()?.holdsPendingReplacement === true
  );
}

/** Enumerate only live invocation/consumer holds, never a plugin-id match. */
export function currentPluginWorkPendingReplacements(): readonly Pick<
  PluginInvocationInstance,
  "pluginId"
>[] {
  const call = pluginInstanceInvocation.getStore();
  const instance = call?.instance;
  return [
    ...new Set([
      ...(instance && call && instance.holdsPendingReplacement(call.token) ? [instance] : []),
      ...(pluginInvocationContext.getStore()?.pendingReplacementInstances ?? []),
    ]),
  ];
}

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

/**
 * Checks the exact invocation authority currently carrying plugin runtime scope.
 *
 * A plugin ID is stable across replacement, so it cannot fence delayed work by
 * itself. The invocation token and instance lifecycle together identify the
 * still-admitted instance that may read prepared capability inputs.
 */
export function hasCurrentPluginInstanceAuthority(pluginId: string): boolean {
  const current = pluginInstanceInvocation.getStore();
  // SAFETY: PluginInstance is the only producer of this private invocation scope.
  const instance = current?.instance as PluginInstanceHandle | undefined;
  return (
    instance?.pluginId === pluginId &&
    instance.hasActiveCall &&
    !instance.owner?.revoked &&
    !instance.lifecycle.signal.aborted
  );
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

/**
 * Digest of a live instance's captured plugin generation source. Core-bundled plugins load
 * host-owned modules and have none; `getPluginInstanceCodeIdentity` covers both.
 */
export function getPluginInstanceSourceDigest(record: PluginRecord): string | undefined {
  return getPluginInstanceIncarnation(record)
    ? pluginInstanceState.records.get(record)?.instance?.sourceDigest
    : undefined;
}

/** Process-local exact-instance identity, preserved by adoption, never reconstructed on reload. */
export function getPluginInstanceIncarnation(record: PluginRecord): string | undefined {
  const owner = pluginInstanceState.records.get(record);
  if (
    !owner?.instance ||
    owner.revoked ||
    !owner.instance.acceptingCalls ||
    owner.instance.lifecycle.signal.aborted
  ) {
    return undefined;
  }
  return (owner.incarnationId ??= randomUUID());
}

/** Exact owner of a callable public view; never inferred from a plugin id or path. */
export function getPluginValueInstance(value: object): PluginInstanceHandle | undefined {
  return pluginInstanceState.values.get(value);
}

/** Only a view's creating instance may restore the original passed back to it. */
export function getPluginOriginalValue(
  value: object,
  instance: PluginInstanceHandle,
): object | undefined {
  return pluginInstanceState.values.getOriginal(value, instance);
}

/** The caller must have created this object; foreign plugin objects remain unmodified. */
export function setPluginOriginalValue(
  value: object,
  original: object,
  instance: PluginInstanceHandle,
): void {
  pluginInstanceState.values.setOriginal(value, original, instance);
}

/** Host consumers retain the exact stream owner until their terminal work settles. */
export function runPluginStreamConsumer<T>(stream: object, consume: () => T): T {
  const instance = getPluginValueInstance(stream);
  return instance ? instance.runConsumer(consume) : consume();
}
