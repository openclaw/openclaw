import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import {
  getPluginInstance,
  getPluginInstanceOwner,
  hasCurrentPluginInstanceAuthority,
} from "../plugins/plugin-instance-scope.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getGatewayServiceLifetime } from "../plugins/runtime/gateway-service-owner.js";
import { getPluginServiceSchedulerBinding } from "../plugins/service-scheduler-binding.js";
import { bindLegacyGitHubOAuthReader } from "./github-oauth-lifecycle-host.compat.js";
import type { LegacyGitHubOAuthService } from "./github-oauth-lifecycle-host.types.js";

/** The existing managed instance projects the canonical plugin record; it owns no native state. */
export function installRepositoryLegacyOAuthLookup(
  read: () => LegacyGitHubOAuthService | undefined,
  serviceSignal: AbortSignal,
): () => void {
  const scheduler = getPluginServiceSchedulerBinding()?.();
  const resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const context = resolveGatewayContext?.();
  const instance = pluginInstanceInvocation.getStore()?.instance;
  const owner = instance && getPluginInstanceOwner(instance);
  const registered = owner && getPluginInstance(owner.record);
  if (
    !scheduler ||
    !resolveGatewayContext ||
    !context ||
    !instance ||
    !owner ||
    owner.revoked ||
    !registered ||
    registered !== instance ||
    instance.pluginId !== "github-repositories" ||
    !hasCurrentPluginInstanceAuthority(instance.pluginId)
  ) {
    throw new Error("Legacy GitHub account lookup requires its live Gateway plugin service.");
  }
  const gateway = getGatewayServiceLifetime({ resolveGatewayContext });
  if (getGatewayServiceLifetime(context) !== gateway) {
    throw new Error("Legacy GitHub account lookup has a different Gateway owner.");
  }
  const signal = AbortSignal.any([
    scheduler.signal,
    instance.lifecycle.signal,
    gateway,
    serviceSignal,
  ]);
  signal.throwIfAborted();
  const source = read();
  if (!source) {
    throw new Error("GitHub account service is unavailable for legacy lookup.");
  }
  const projected = registered.createRegistryView(owner.registry, (run) => {
    signal.throwIfAborted();
    if (read() !== source) {
      throw new Error("The GitHub account service record changed.");
    }
    return run();
  })(source);
  const lookup = () => (signal.aborted || read() !== source ? undefined : projected);
  return bindLegacyGitHubOAuthReader(gateway, lookup, signal);
}
