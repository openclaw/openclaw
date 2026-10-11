/** Refreshes the persisted plugin registry for mutation and doctor flows. */
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import type { InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store.js";
import type { RefreshInstalledPluginIndexParams } from "./installed-plugin-index.js";
import type { PluginLifecycleLeaseContext } from "./plugin-lifecycle-lease.js";
import {
  resolveControlPlaneRegistryParams,
  type PluginRegistrySnapshot,
} from "./plugin-registry-snapshot.js";

export async function refreshPluginRegistry(
  params: RefreshInstalledPluginIndexParams &
    InstalledPluginIndexStoreOptions & {
      lease?: PluginLifecycleLeaseContext;
    },
): Promise<PluginRegistrySnapshot> {
  return await refreshPersistedInstalledPluginIndex(resolveControlPlaneRegistryParams(params));
}
