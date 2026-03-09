import type { ResolvedSnapshotStoreConfig } from "./config.js";
import { createFolderSnapshotStore } from "./provider-folder.js";
import type { BackupSnapshotStore } from "./types.js";

export function createSnapshotStore(config: ResolvedSnapshotStoreConfig): BackupSnapshotStore {
  return createFolderSnapshotStore(config);
}
