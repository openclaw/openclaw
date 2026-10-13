import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { matchesDeclaredProviderOwner } from "./provider-owner-index.js";
import type { PluginProviderRegistration } from "./provider-plugin.types.js";
import { getProviderRegistryIndex } from "./provider-registry-index.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContextState } from "./runtime/load-context-state.js";

/** Selects the current provider registration without reading unrelated runtime fields. */
export function findProviderRuntimeRegistrationInRegistry(params: {
  registry: { providers: readonly PluginProviderRegistration[] };
  provider: string;
  ownerRefs: readonly string[];
  isOwnerEligible?: (pluginId: string) => boolean;
}): PluginProviderRegistration | undefined {
  const scope = getPluginRuntimeGatewayRequestScope();
  const owners =
    (scope?.pluginRegistry === params.registry ? scope.declaredProviderOwners : undefined) ??
    getPluginRuntimeLoadContextState(params.registry)?.declaredProviderOwners;
  const isOwnerEligible =
    params.isOwnerEligible ??
    ((id: string) => matchesDeclaredProviderOwner(owners, params.provider, id));
  const literalId = normalizeLowercaseStringOrEmpty(params.provider);
  const providers = params.registry.providers;
  const index = getProviderRegistryIndex(providers);
  const eligible = (position: number) => isOwnerEligible(providers[position]!.pluginId);
  // A registered provider owns its name; another provider's compatibility
  // alias must not replace its executable hooks in a shared generation.
  let position = index.ids.get(literalId)?.find(eligible);
  if (position === undefined) {
    const candidates =
      params.ownerRefs.length === 0
        ? index.refs.get(literalId)
        : [
            ...new Set([
              ...(index.ids.get(literalId) ?? []),
              ...params.ownerRefs.flatMap(
                (ref) => index.refs.get(normalizeLowercaseStringOrEmpty(ref)) ?? [],
              ),
            ]),
          ].toSorted((left, right) => left - right);
    position = candidates?.find(eligible);
  }
  return position === undefined ? undefined : providers[position];
}
