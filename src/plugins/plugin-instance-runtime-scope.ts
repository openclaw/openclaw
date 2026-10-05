import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import type { PluginInstanceInvocation } from "./plugin-instance-invocation.types.js";
import type { PluginInstanceOwner } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";
import { withPluginRuntimePluginScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";

/** Prepared calls keep their registry; detached calls follow the instance's adopted owner. */
export function withPluginInstanceRuntimeScope<T>(
  owner: PluginInstanceOwner,
  admittedRegistry: PluginRegistry | undefined,
  call: PluginInstanceInvocation,
  run: () => T,
): T {
  const { record } = owner;
  const generation = getPluginRuntimeGenerationRegistry();
  const registry =
    admittedRegistry ?? (generation?.plugins.includes(record) ? generation : owner.registry);
  if (!registry) {
    throw new PluginInstanceUnavailableError(record.id);
  }
  return withPluginRuntimePluginScope(
    {
      pluginId: record.id,
      pluginSource: record.source,
      pluginOrigin: record.origin,
      pluginTrustedOfficialInstall: record.trustedOfficialInstall,
    },
    run,
    registry,
    call,
  );
}
