/** Refreshes the persisted plugin registry for mutation and doctor flows. */
import { resolveInstalledPluginIndexStateDatabaseOptions } from "./installed-plugin-index-store-path.js";
import {
  refreshPersistedInstalledPluginIndex,
  type InstalledPluginIndexWriteLease,
} from "./installed-plugin-index-store-write.js";
import type { InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store.js";
import type { RefreshInstalledPluginIndexParams } from "./installed-plugin-index.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  resolveControlPlaneRegistryParams,
  type PluginRegistrySnapshot,
} from "./plugin-registry-snapshot.js";

export async function refreshPluginRegistry(
  params: RefreshInstalledPluginIndexParams &
    InstalledPluginIndexStoreOptions & {
      lease?: InstalledPluginIndexWriteLease;
    },
): Promise<PluginRegistrySnapshot> {
  return await withPluginLifecycleLease(
    resolveInstalledPluginIndexStateDatabaseOptions(params),
    async () =>
      refreshPersistedInstalledPluginIndex(
        params.config ? resolveControlPlaneRegistryParams(params) : params,
      ),
  );
}
