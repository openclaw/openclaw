import type { ResolvedSnapshotStoreConfig, ResolvedSnapshotStoreTargetConfig } from "./config.js";
import { createFolderSnapshotStore, createFolderSnapshotListStore } from "./provider-folder.js";
import type { BackupSnapshotListStore, BackupSnapshotStore } from "./types.js";

export function createSnapshotStore(config: ResolvedSnapshotStoreConfig): BackupSnapshotStore {
  return createFolderSnapshotStore(config);
}

/** Create a store that only supports listing snapshots (no encryption key needed). */
export function createSnapshotListStore(
  config: ResolvedSnapshotStoreTargetConfig,
): BackupSnapshotListStore {
  return createFolderSnapshotListStore(config);
}
