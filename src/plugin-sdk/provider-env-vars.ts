// Public provider auth environment variable helpers for plugin runtimes.
import { buildPluginMetadataProviderFacts } from "../plugins/plugin-metadata-provider-facts.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  getProviderEnvVarsCore,
  listKnownProviderAuthEnvVarNamesCore,
  resolveProviderAuthEnvVarCandidatesCore,
  type ProviderEnvVarLookupParams as CoreLookupParams,
} from "../secrets/provider-env-vars.js";

export { omitEnvKeysCaseInsensitive } from "../secrets/provider-env-vars.js";

type ProviderEnvVarLookupParams =
  | CoreLookupParams
  | (Omit<CoreLookupParams, "metadataSnapshot"> & {
      metadataSnapshot: Omit<PluginMetadataSnapshot, "owners"> & {
        owners: Omit<PluginMetadataSnapshot["owners"], "providerAuthContributions">;
      };
    });

function hasPreparedLookupParams(params: ProviderEnvVarLookupParams): params is CoreLookupParams {
  const snapshot = params.metadataSnapshot;
  return (
    snapshot === undefined ||
    ("providerAuthContributions" in snapshot.owners &&
      snapshot.owners.providerAuthContributions !== undefined)
  );
}

// v2026.9.4 accepted snapshots before these prepared facts existed. Keep this
// adaptation at the SDK boundary until an approved SDK-breaking release.
function prepareLookupParams(params?: ProviderEnvVarLookupParams): CoreLookupParams | undefined {
  if (!params || hasPreparedLookupParams(params)) {
    return params;
  }
  const snapshot = params.metadataSnapshot;
  return {
    ...params,
    metadataSnapshot: {
      ...snapshot,
      owners: {
        ...snapshot.owners,
        providerAuthContributions: buildPluginMetadataProviderFacts(snapshot.plugins)
          .providerAuthContributions,
      },
    },
  };
}

export function getProviderEnvVars(
  providerId: string,
  params?: ProviderEnvVarLookupParams,
): string[] {
  return getProviderEnvVarsCore(providerId, prepareLookupParams(params));
}

export function listKnownProviderAuthEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return listKnownProviderAuthEnvVarNamesCore(prepareLookupParams(params));
}

export function resolveProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return resolveProviderAuthEnvVarCandidatesCore(prepareLookupParams(params));
}
