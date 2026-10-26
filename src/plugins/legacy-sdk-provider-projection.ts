import {
  getLegacyPluginSdkResourceHost,
  type LegacyPluginSdkProviderProjection,
} from "./legacy-sdk-resource-host.js";
import { getPluginInstance, type PluginInstanceHandle } from "./plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "./plugin-instance.types.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import type { PluginRegistry } from "./registry-types.js";

/** One selection checks source admission; adopted host views retain their exact consumers. */
export function createLegacyPluginSdkProviderProjection() {
  let host: ReturnType<typeof getLegacyPluginSdkResourceHost> | undefined;
  const selected = new Map<object, LegacyPluginSdkProviderProjection>();
  const pending = new Map<object, { release: () => Promise<void> }>();
  return {
    select(registry: PluginRegistry | undefined) {
      const source = registry && getPluginRegistryInspectionResources(registry);
      if (!registry || !source) {
        return undefined;
      }
      host ??= getLegacyPluginSdkResourceHost();
      host.assertOpen();
      let projection = selected.get(source);
      if (!projection) {
        // New operations still check inspection admission even when the host already has views.
        const physical = source.retain();
        const owner = host;
        projection = owner.getProviderProjection(source, () => {
          const consumers = new Map<PluginInstanceHandle, PluginInstanceConsumer>();
          let references = 0;
          const shared: LegacyPluginSdkProviderProjection = {
            retain(claim) {
              references++;
              let released: Promise<void> | undefined;
              return {
                release: () => {
                  if (!released) {
                    if (--references === 0) {
                      // Instance disposal waits for consumers; close views before the final claim.
                      consumers.forEach((consumer) => consumer.release());
                      consumers.clear();
                      owner.forgetProviderProjection(source, shared);
                    }
                    released = claim.release();
                  }
                  return released;
                },
              };
            },
            project<T>(provider: T, instance: PluginInstanceHandle | undefined): T {
              owner.assertOpen();
              if (!instance) {
                return provider;
              }
              let consumer = consumers.get(instance);
              if (!consumer) {
                consumer = instance.retainConsumer((run) => owner.invoke(run));
                consumers.set(instance, consumer);
              }
              const retained = consumer;
              return retained.run(() => retained.wrap(provider));
            },
          };
          return shared;
        });
        pending.set(source, projection.retain(physical));
        selected.set(source, projection);
      }
      const retained = projection;
      return <T>(provider: T, pluginId: string): T => {
        const record = registry.plugins.find((entry) => entry.id === pluginId);
        return retained.project(provider, record && getPluginInstance(record));
      };
    },
    adopt() {
      host?.assertOpen();
      for (const [source, claim] of pending) {
        host!.adopt(source, claim);
        pending.delete(source);
      }
    },
    [Symbol.dispose]() {
      const claims = [...pending.values()];
      pending.clear();
      for (const claim of claims) {
        host!.releaseClaim(claim);
      }
    },
  };
}
