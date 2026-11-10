import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  matchesDeclaredProviderOwner,
  type DeclaredProviderOwnerIndex,
} from "./provider-owner-index.js";
import type { PluginProviderRegistration } from "./provider-plugin.types.js";
import { projectRegisteredProvider } from "./provider-registration-projection.js";
import { getProviderRegistryIndex } from "./provider-registry-index.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContextState } from "./runtime/load-context-state.js";
import type { ProviderPlugin } from "./types.js";

export function captureProviderRegistrySelection(
  registry: PluginRegistry,
  base: { workspaceDir?: string; declaredProviderOwners: DeclaredProviderOwnerIndex },
  onlyPluginIds?: readonly string[],
) {
  return {
    registry,
    workspaceDir: base.workspaceDir,
    onlyPluginIds,
    isProviderOwnerEligible: (pluginId: string, provider: string) =>
      (!onlyPluginIds || onlyPluginIds.includes(pluginId)) &&
      matchesDeclaredProviderOwner(base.declaredProviderOwners, provider, pluginId),
  };
}

export function projectProviderRegistrySelection(
  selection: ReturnType<typeof captureProviderRegistrySelection> | undefined,
  project = projectRegisteredProvider,
): ProviderPlugin[] {
  if (!selection) {
    return [];
  }
  const { registry, onlyPluginIds } = selection;
  return registry.providers
    .filter((entry) => !onlyPluginIds || onlyPluginIds.includes(entry.pluginId))
    .map((entry) => project(entry.provider, entry.pluginId));
}

export function selectDeclaredProviderLiteral(
  registry: PluginRegistry,
  provider: string,
  workspaceDir: string | undefined,
  declaredProviderOwners: DeclaredProviderOwnerIndex | undefined,
): ReturnType<typeof captureProviderRegistrySelection> | undefined {
  const owners = declaredProviderOwners?.get(normalizeProviderId(provider));
  if (!declaredProviderOwners || !owners) {
    return undefined;
  }
  // A declared literal receiver wins before aliases and model-owner projections.
  // Require positive ownership in the retained generation; ordinary loaded registries
  // still need the resolver's full physical-source, activation and config checks.
  const registration = findProviderRuntimeRegistrationInRegistry({
    registry,
    provider,
    ownerRefs: [],
    literalOnly: true,
    isOwnerEligible: (id) => owners.has(id),
  });
  return registration
    ? captureProviderRegistrySelection(registry, { workspaceDir, declaredProviderOwners }, [
        registration.pluginId,
      ])
    : undefined;
}

/** Selects the current provider registration without reading unrelated runtime fields. */
export function findProviderRuntimeRegistrationInRegistry(params: {
  registry: { providers: readonly PluginProviderRegistration[] };
  provider: string;
  ownerRefs: readonly string[];
  isOwnerEligible?: (pluginId: string) => boolean;
  literalOnly?: boolean;
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
  if (position === undefined && !params.literalOnly) {
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
            // oxlint-disable-next-line unicorn/no-array-sort -- The spread creates a private array.
          ].sort((left, right) => left - right);
    position = candidates?.find(eligible);
  }
  return position === undefined ? undefined : providers[position];
}
