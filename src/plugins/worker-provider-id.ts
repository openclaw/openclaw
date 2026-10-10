import { normalizeCapabilityProviderId } from "./provider-registry-shared.js";

export function normalizeWorkerProviderIds(providerIds: readonly string[]): string[] {
  const normalized = providerIds
    .map(normalizeCapabilityProviderId)
    .filter((id): id is string => id !== undefined);
  return [...new Set(normalized)].toSorted();
}
