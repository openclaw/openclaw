/** Resolves whether a provider plugin owns rate limiting and account health. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveProviderModelPolicySurface } from "./provider-model-routes.js";
import { findProviderRuntimePluginInRegistry } from "./provider-registry-selection.js";
import { getPluginRegistryState } from "./runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-state.js";

/**
 * Reads `managesOwnAvailability` for one provider without loading plugin
 * runtime. The lightweight policy artifact answers first so cold CLI and
 * status paths agree with routing; an already-loaded provider plugin answers
 * for plugins that ship no artifact. Unknown providers default to false, so
 * cooldown bookkeeping stays on.
 */
export function resolveProviderManagesOwnAvailability(params: {
  provider: string | undefined;
}): boolean {
  const provider = normalizeProviderId(params.provider ?? "");
  if (!provider) {
    return false;
  }
  const declared = resolveProviderModelPolicySurface(provider)?.managesOwnAvailability;
  if (declared !== undefined) {
    return declared;
  }
  // Prepared runs pin their generation registry; otherwise read the request or
  // process-active registry. Neither path discovers or activates plugins.
  const registry =
    getPluginRuntimeGenerationRegistry() ??
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
    getPluginRegistryState()?.activeRegistry;
  if (!registry) {
    return false;
  }
  return (
    findProviderRuntimePluginInRegistry({ registry, provider, ownerRefs: [] })
      ?.managesOwnAvailability === true
  );
}
