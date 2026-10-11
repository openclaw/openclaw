import { captureSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker-context.js";
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
  const runWithReadOnlyWorkers = captureSqliteReadOnlyWorkerScope();
  const resourceHost = withPluginRuntimeGatewayContextResolver(
    undefined,
    getBoundLegacyPluginSdkResourceHost,
    { inheritRequestScope: false },
  );
  return (run) => {
    const current = pluginInstanceInvocation.getStore();
    const cleanup =
      current?.instance === instance && instance.hasActiveCall && isCleanup(current.token)
        ? { instance, token: current.token }
        : undefined;
    const registry = instance.owner?.registry;
    const runtime = registry && getPluginRegistryRuntime(registry);
    const resolver = runtime && getGatewayContextResolver(runtime);
    return runInDetachedAsyncContext(() =>
      runWithSpawnBroker(spawnBroker, () =>
        runWithReadOnlyWorkers(() =>
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
