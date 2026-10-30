import { runOutsideOperatorToolGatewayAuthority } from "../gateway/operator-tool-gateway-authority.js";
import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import { withPluginHttpRouteRegistry } from "./http-registry.js";
import { getBoundLegacyPluginSdkResourceHost } from "./legacy-sdk-resource-host.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import type { PluginInstanceHandle } from "./plugin-instance-scope.js";
import { getPluginRecordRegistry } from "./registry-lifecycle.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";

export function createPluginServiceSchedulerRunner(owner: {
  registry: PluginRegistry;
  record?: PluginRecord;
  instance?: PluginInstanceHandle;
  lease: PluginRuntimeCapabilityLease;
}) {
  const runtime = getPluginRegistryRuntime(owner.registry);
  const resolveGatewayContext = runtime ? getGatewayContextResolver(runtime) : undefined;
  const resourceHost = resolveGatewayContext
    ? undefined
    : withPluginRuntimeGatewayContextResolver(undefined, getBoundLegacyPluginSdkResourceHost, {
        inheritRequestScope: false,
      });
  const runScheduled = createScheduledGatewayRunner(resolveGatewayContext);
  return (work: () => void | Promise<unknown>) =>
    runOutsideOperatorToolGatewayAuthority(() =>
      runScheduled(async () =>
        pluginInstanceInvocation.exit(() => {
          const registry = owner.record
            ? getPluginRecordRegistry(owner.registry, owner.record)
            : owner.registry;
          const run = () => withPluginHttpRouteRegistry(registry, work, owner.lease);
          // The lifecycle owner joins scheduled work before disposal can finish.
          const invoke = () =>
            owner.instance
              ? owner.instance.runInRegistry(registry, run, { joinDisposal: false })
              : run();
          return withPluginRuntimeGatewayContextResolver(
            resolveGatewayContext,
            () => {
              resourceHost?.assertOpen();
              return resourceHost ? resourceHost.run(invoke) : invoke();
            },
            { inheritRequestScope: false },
          );
        }),
      ),
    );
}
