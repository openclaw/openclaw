import { runWithAsyncStore } from "../shared/async-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import {
  getPluginInstance,
  getPluginValueInstance,
  pluginInvocationContext,
  type PluginInstanceHandle,
  type PluginInvocationBinding,
  type PluginInvocationContext,
} from "./plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "./plugin-instance.types.js";
import type { PluginRegistry } from "./registry-types.js";

/** Host teardown may cross exact plugin owners after ordinary admission closes. */
export async function runPluginCleanupScope<T>(values: readonly object[], run: () => Promise<T>) {
  const instances = new Set(
    values.map(getPluginValueInstance).filter((instance) => instance !== undefined),
  );
  const parent = pluginInvocationContext.getStore();
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Plugin cleanup scope is closed");
    }
  };
  const bindings = new Map(
    [...instances].map((instance) => [
      instance,
      {
        run: <R>(operation: () => R) => {
          assertOpen();
          return instance.runCleanup(operation);
        },
        wrap: <R>(value: R) => {
          assertOpen();
          return instance.wrap(value);
        },
      },
    ]),
  );
  try {
    return await runWithAsyncStore(
      pluginInvocationContext,
      {
        lookup: (instance) => {
          const binding = bindings.get(instance);
          if (binding) {
            assertOpen();
          }
          return binding ?? parent?.lookup(instance);
        },
      },
      run,
    );
  } finally {
    closed = true;
  }
}

/** Finite execution custody for one host-selected registry and its exact instances. */
export class PluginInvocationScope {
  private readonly bindings: Map<PluginInstanceHandle, PluginInvocationBinding>;
  private readonly consumers?: Map<PluginInstanceHandle, PluginInstanceConsumer>;
  private closed = false;

  constructor(
    readonly registry: PluginRegistry,
    instances: Iterable<PluginInstanceHandle>,
    options: {
      retained?: boolean;
      parent?: PluginInvocationContext;
      kind?: "work" | "custody";
      registryByInstance?: ReadonlyMap<PluginInstanceHandle, PluginRegistry>;
    } = {},
  ) {
    this.bindings = options.retained ? (this.consumers = new Map()) : new Map();
    const consumerKind = options.kind ?? "work";
    const invoke = <T>(run: () => T): T => this.run(run);
    try {
      for (const instance of instances) {
        if (this.bindings.has(instance)) {
          continue;
        }
        const instanceRegistry = options.registryByInstance?.get(instance) ?? registry;
        if (this.consumers) {
          const acquire = () =>
            instance.retainConsumer(invoke, instanceRegistry, consumerKind, {
              reason: "invocation-scope",
            });
          const parent = options.parent?.lookup(instance);
          const consumer = parent ? parent.run(acquire) : acquire();
          this.consumers.set(instance, consumer);
        } else {
          this.bindings.set(instance, {
            run: (run) => this.run(() => instance.runInRegistry(instanceRegistry, run)),
            wrap: instance.createRegistryView(instanceRegistry, invoke),
          });
        }
      }
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Plugin invocation scope is closed");
    }
  }

  get pendingReplacementInstances(): readonly PluginInstanceHandle[] {
    return this.closed || !this.consumers
      ? []
      : [...this.consumers.keys()].filter((instance) => instance.replacementPending);
  }

  get holdsPendingReplacement(): boolean {
    return this.pendingReplacementInstances.length > 0;
  }

  lookup(instance: PluginInstanceHandle): PluginInvocationBinding | undefined {
    const binding = this.bindings.get(instance);
    if (binding) {
      this.assertOpen();
    }
    return binding;
  }

  run<T>(run: () => T): T {
    this.assertOpen();
    if (this.consumers?.size && pluginInvocationContext.getStore() !== this) {
      // A child owns its streams; inherited caller tokens must not capture them.
      // Consumer reentry within this scope keeps the token it just installed.
      return pluginInstanceInvocation.exit(() =>
        runWithAsyncStore(pluginInvocationContext, this, run),
      );
    }
    return runWithAsyncStore(pluginInvocationContext, this, run);
  }

  wrap<T>(value: T): T {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return value;
    }
    const instance = getPluginValueInstance(value);
    return instance ? (this.lookup(instance)?.wrap(value) ?? value) : value;
  }

  /** Transfer custody before revoking callbacks captured by ordinary engine operations. */
  beginCleanup(): { scope: PluginInvocationScope; release: () => Promise<void> } {
    this.assertOpen();
    // Retained scopes install teardown bindings below, not temporary ordinary views.
    const cleanup = new PluginInvocationScope(
      this.registry,
      this.consumers?.size ? [] : this.bindings.keys(),
    );
    const finished = createDeferredCore();
    // Retirement may already await these exact consumers. Revoke their callbacks
    // now, but keep their physical completion until the cleanup owner drains.
    const closed = Promise.all(
      [...(this.consumers ?? [])].map(([instance, consumer]) =>
        consumer.close(() => {
          const teardown = pluginInstanceInvocation.getStore();
          if (!teardown) {
            throw new Error("Plugin consumer cleanup has no invocation");
          }
          // Transfer only the teardown token, never the closed operation scope or caller authority.
          const run = <T>(operation: () => T): T =>
            cleanup.run(() =>
              pluginInstanceInvocation.run(teardown, () => instance.runCleanup(operation)),
            );
          cleanup.bindings.set(instance, {
            run,
            wrap: instance.createRegistryView(this.registry, run),
          });
          return finished.promise;
        }),
      ),
    );
    void closed.catch(() => {});
    this.closed = true;
    return {
      scope: cleanup,
      release: async () => {
        cleanup.release();
        finished.resolve();
        await closed;
      },
    };
  }

  release(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const consumer of this.consumers?.values() ?? []) {
      consumer.release();
    }
  }
}

/** Enumerate exact instances already represented by this finite registry view. */
export function collectRegistryInvocationInstances(
  registry: PluginRegistry,
  overlapOnly = false,
): Set<PluginInstanceHandle> {
  const instances = new Set<PluginInstanceHandle>();
  const add = (instance: PluginInstanceHandle | undefined) => {
    if (instance && (!overlapOnly || instance.owner?.record.generationOverlap === true)) {
      instances.add(instance);
    }
  };
  for (const record of registry.plugins) {
    // Rollback preserves failed records for diagnostics, not executable custody.
    if (record.status === "loaded") {
      add(getPluginInstance(record));
    }
  }
  for (const { host } of registry.decisionProviders) {
    add(getPluginInstance(host.record));
  }
  for (const { borrowedRuntimeRecord } of registry.channels) {
    if (borrowedRuntimeRecord) {
      add(getPluginInstance(borrowedRuntimeRecord));
    }
  }
  for (const { factory } of registry.tools) {
    add(getPluginValueInstance(factory));
  }
  for (const { plugin } of registry.channels) {
    add(getPluginValueInstance(plugin));
  }
  for (const { factory } of registry.contextEngines.values()) {
    add(getPluginValueInstance(factory));
  }
  for (const { presenter } of registry.widgetPresenters) {
    add(getPluginValueInstance(presenter));
  }
  for (const { supplement } of registry.memoryCorpusSupplements) {
    add(getPluginValueInstance(supplement));
  }
  for (const { prepare } of registry.memoryPromptPreparations) {
    add(getPluginValueInstance(prepare));
  }
  for (const { builder } of registry.memoryPromptSupplements) {
    add(getPluginValueInstance(builder));
  }
  return instances;
}
