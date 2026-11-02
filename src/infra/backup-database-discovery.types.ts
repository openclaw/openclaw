import type { ActivatedPluginBackupInventory } from "../plugins/manifest-backup-resources.js";
import type { discoverBackupDatabasePaths } from "./backup-sqlite-snapshot.js";
import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";

export type BackupDatabaseDiscoveryInput = Parameters<typeof discoverBackupDatabasePaths>[0] & {
  workspaceDirs?: readonly string[];
};
export type BackupDatabaseDiscoveryReply = {
  paths: string[];
  stateRoots: readonly string[];
  pluginOwners: DatabasePortPluginOwners;
  pluginInventory: ActivatedPluginBackupInventory;
  resources: Array<{ path: string; family: string; pluginId: string }>;
};
