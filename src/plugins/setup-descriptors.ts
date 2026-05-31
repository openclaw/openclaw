import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginManifestRecord } from "./manifest-registry.js";

type SetupDescriptorRecord = Pick<
  PluginManifestRecord,
  "providers" | "cliBackends" | "providerAuthAliases" | "setup"
>;

/**
 * List provider ids exposed by setup descriptors, including auth aliases for those providers.
 */
export function listSetupProviderIds(record: SetupDescriptorRecord): readonly string[] {
  const providerIds = record.setup?.providers?.map((entry) => entry.id) ?? record.providers;
  const normalizedProviderIds = new Set(providerIds.map(normalizeProviderId));
  const aliases = Object.entries(record.providerAuthAliases ?? {})
    .filter(([, target]) => normalizedProviderIds.has(normalizeProviderId(target)))
    .map(([alias]) => alias);
  return [...providerIds, ...aliases];
}

/**
 * List CLI backend ids exposed by setup descriptors with legacy manifest fallback.
 */
export function listSetupCliBackendIds(record: SetupDescriptorRecord): readonly string[] {
  return record.setup?.cliBackends ?? record.cliBackends;
}
