import type {
  HostedOfficialExternalPluginCatalogSnapshot,
  HostedOfficialExternalPluginCatalogSnapshotStore,
} from "./official-external-plugin-catalog.types.js";

export function createInMemoryHostedCatalogSnapshotStore(
  initialSnapshots: HostedOfficialExternalPluginCatalogSnapshot[] = [],
): HostedOfficialExternalPluginCatalogSnapshotStore {
  const snapshots = new Map<string, HostedOfficialExternalPluginCatalogSnapshot>();
  for (const snapshot of initialSnapshots) {
    snapshots.set(snapshot.metadata.url, snapshot);
  }
  return {
    async read(url) {
      return snapshots.get(url) ?? null;
    },
    async write(snapshot) {
      snapshots.set(snapshot.metadata.url, snapshot);
    },
  };
}
