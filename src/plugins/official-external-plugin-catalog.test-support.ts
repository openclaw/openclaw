import type {
  HostedOfficialExternalPluginCatalogSnapshot,
  OfficialExternalPluginCatalogEntry,
  OfficialExternalPluginCatalogFeed,
  OfficialExternalPluginCatalogInstallCandidate,
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

export function installableEntry(
  id: string,
  candidate: OfficialExternalPluginCatalogInstallCandidate = {},
): OfficialExternalPluginCatalogEntry {
  return {
    type: "plugin",
    id,
    state: "available",
    publisher: { id: "acme", trust: "official" },
    install: {
      candidates: [{ sourceRef: "public-clawhub", package: id, version: "1.2.3", ...candidate }],
    },
  };
}

export function hostedCatalogFeed(params: {
  sequence: number;
  pluginName: string;
  expiresAt?: string;
}): OfficialExternalPluginCatalogFeed {
  const pluginId = params.pluginName.replace(/^@[^/]+\//u, "");
  return {
    schemaVersion: 1,
    id: "openclaw-official-external-plugins",
    generatedAt: `2026-06-22T00:00:${String(params.sequence).padStart(2, "0")}.000Z`,
    expiresAt: params.expiresAt ?? "2099-01-01T00:00:00.000Z",
    sequence: params.sequence,
    entries: [
      {
        name: params.pluginName,
        kind: "plugin",
        openclaw: {
          plugin: { id: pluginId },
          install: { sourceRef: "acme-npm", npmSpec: params.pluginName },
        },
      },
    ],
  };
}
