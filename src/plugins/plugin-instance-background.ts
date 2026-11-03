import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker-context.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { getBoundLegacyPluginSdkResourceHost } from "./legacy-sdk-resource-host.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import type { PluginInstanceHandle } from "./plugin-instance-scope.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";

/** Capture host bindings without retaining registration's request or registry generation. */
export function createPluginBackgroundRunner(
  instance: PluginInstanceHandle,
  isCleanup: (token: object) => boolean,
): <T>(run: () => T) => T {
  const spawnBroker = getSpawnBroker();
  const readOnlyWorkers = createSqliteReadOnlyWorkerScope();
  // Close after admitted work and plugin cleanup, never with the loading caller.
  instance.onModuleDispose(() => readOnlyWorkers.close());
  const resourceHost = withPluginRuntimeGatewayContextResolver(
    undefined,
    getBoundLegacyPluginSdkResourceHost,
    { inheritRequestScope: false },
  );
  return (run) => {
    const current = pluginInstanceInvocation.getStore();
    const cleanup =
      current?.instance === instance && isCleanup(current.token)
        ? { instance, token: current.token }
        : undefined;
    const registry = instance.owner?.registry;
    const runtime = registry && getPluginRegistryRuntime(registry);
    const resolver = runtime && getGatewayContextResolver(runtime);
    return runInDetachedAsyncContext(() =>
      runWithSpawnBroker(spawnBroker, () =>
        readOnlyWorkers.run(() =>
          withPluginRuntimeGatewayContextResolver(resolver, () => {
            // Only an already admitted cleanup may cross ordinary retirement.
            const invoke = () =>
              cleanup
                ? pluginInstanceInvocation.run(cleanup, () => instance.run(run))
                : instance.runInRegistry(registry, run, { joinDisposal: false });
            return !resolver && resourceHost ? resourceHost.run(invoke) : invoke();
          }),
        ),
      ),
    );
  };
}
