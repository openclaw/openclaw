import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { getBoundLegacyPluginSdkResourceHost } from "./legacy-sdk-resource-host.js";
import type { PluginInstanceHandle } from "./plugin-instance-scope.js";
import { withPluginServiceSchedulerBinding } from "./service-scheduler-binding.js";
import { createPluginServiceSchedulerRunner } from "./service-scheduler-context.js";
import { createPluginServiceScheduler } from "./service-scheduler.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";

export function withPluginCliServiceScheduler<T>(instance: PluginInstanceHandle, run: () => T): T {
  const host = getBoundLegacyPluginSdkResourceHost();
  const owner = instance.owner;
  let scheduler: PluginServiceSchedulerV1 | undefined;
  // Programmatic registration can build a command tree without admitting timed work.
  const binding =
    host && owner
      ? () => {
          host.assertOpen();
          instance.lifecycle.signal.throwIfAborted();
          if (!instance.hasActiveCall || !instance.acceptingCalls || owner.revoked) {
            throw new Error("Plugin CLI scheduler requires its active plugin invocation");
          }
          if (!scheduler) {
            const lease = createPluginRuntimeCapabilityLease("plugin CLI");
            scheduler = host.run(
              () =>
                createPluginServiceScheduler(
                  host.scheduler,
                  createPluginServiceSchedulerRunner({ ...owner, instance, lease }),
                ).scheduler,
            );
            const scope = scheduler;
            const close = async () => {
              scope.beginClose();
              await scope.stop();
              lease.revoke();
            };
            host.adopt(scope, { release: close });
            instance.lifecycle.onDispose(close);
          }
          return scheduler;
        }
      : undefined;
  return withPluginServiceSchedulerBinding(binding, run);
}
