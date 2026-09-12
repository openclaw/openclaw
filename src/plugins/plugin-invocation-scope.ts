import {
  getPluginInstance,
  getPluginValueInstance,
  pluginInvocationContext,
  type PluginInstanceHandle,
  type PluginInvocationBinding,
} from "./plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "./plugin-instance.types.js";
import type { PluginRegistry } from "./registry-types.js";

/** Finite execution custody for one host-selected registry and its exact instances. */
export class PluginInvocationScope {
  private readonly bindings = new Map<PluginInstanceHandle, PluginInvocationBinding>();
  private readonly consumers = new Map<PluginInstanceHandle, PluginInstanceConsumer>();
  private closed = false;

  constructor(
    readonly registry: PluginRegistry,
    instances: Iterable<PluginInstanceHandle>,
    options: { retained?: boolean; parent?: PluginInvocationScope } = {},
  ) {
    try {
      for (const instance of new Set(instances)) {
        if (options.retained) {
          const acquire = () => instance.retainConsumer((run) => this.run(run), registry);
          const parent = options.parent?.consumer(instance);
          const consumer = parent ? parent.run(acquire) : acquire();
          this.consumers.set(instance, consumer);
          this.bindings.set(instance, consumer);
        } else {
          this.bindings.set(instance, {
            run: (run) => this.run(() => instance.runInRegistry(registry, run)),
            wrap: instance.createRegistryView(registry, (run) => this.run(run)),
          });
        }
      }
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private consumer(instance: PluginInstanceHandle): PluginInstanceConsumer | undefined {
    this.assertOpen();
    return this.consumers.get(instance);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Plugin invocation scope is closed");
    }
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
    return pluginInvocationContext.run(this, run);
  }

  wrap<T>(value: T): T {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return value;
    }
    const instance = getPluginValueInstance(value);
    return instance ? (this.lookup(instance)?.wrap(value) ?? value) : value;
  }

  release(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const consumer of this.consumers.values()) {
      consumer.release();
    }
  }
}

/** Enumerate exact instances already represented by this finite registry view. */
export function collectRegistryInvocationInstances(
  registry: PluginRegistry,
): Set<PluginInstanceHandle> {
  const instances = new Set<PluginInstanceHandle>();
  for (const record of registry.plugins) {
    const instance = getPluginInstance(record);
    if (instance) {
      instances.add(instance);
    }
  }
  const values = [
    ...[...registry.contextEngines.values()].map(({ factory }) => factory),
    ...registry.widgetPresenters.map(({ presenter }) => presenter),
    ...registry.memoryCorpusSupplements.map(({ supplement }) => supplement),
    ...registry.memoryPromptPreparations.map(({ prepare }) => prepare),
    ...registry.memoryPromptSupplements.map(({ builder }) => builder),
  ];
  for (const value of values) {
    const instance = getPluginValueInstance(value);
    if (instance) {
      instances.add(instance);
    }
  }
  return instances;
}
