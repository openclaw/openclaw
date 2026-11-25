/** Reads static provider availability ownership without loading provider runtime. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  getCurrentPluginMetadataSnapshotRequiredRuntime,
  loadPluginMetadataSnapshotRuntime,
} from "./plugin-metadata-snapshot-required.js";

export function resolveProviderManagesOwnAvailability(providerId: string): boolean {
  const provider = normalizeProviderId(providerId);
  if (!provider) {
    return false;
  }
  const snapshot =
    getCurrentPluginMetadataSnapshotRequiredRuntime({
      allowScopedSnapshot: true,
      allowWorkspaceScopedSnapshot: true,
    }) ?? loadPluginMetadataSnapshotRuntime({ config: getRuntimeConfigSnapshot() ?? {} });
  return snapshot.owners.providersManagingOwnAvailability?.has(provider) === true;
}
