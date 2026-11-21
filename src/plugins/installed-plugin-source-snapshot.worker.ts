import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import {
  parseInstalledPluginIndexRow,
  readInstalledPluginIndexRow,
  writePersistedInstalledPluginIndexToSqlite,
  type InstalledPluginIndexWriteLease,
  type InstalledPluginIndexWriteOperations,
  type InstalledPluginIndexWriteReceipt,
} from "./installed-plugin-index-store-write.js";
import { parseInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";

/** Lazy publication never overwrites a successor selected while its source was captured. */
export function updateInstalledPluginSourceSnapshotsInDatabase(
  changes: InstalledPluginIndexWriteOperations["plugins.metadata.index.sourceSnapshots"]["input"]["changes"],
  database: OpenClawStateDatabase,
  lease: InstalledPluginIndexWriteLease,
): (InstalledPluginIndexWriteReceipt & { index: InstalledPluginIndex }) | null {
  if (
    !changes.sourceSnapshots?.length &&
    !changes.sourceSnapshotRemovals?.length &&
    !changes.sourceSnapshotRetirements?.length &&
    !changes.collectedSourceSnapshots?.length
  ) {
    return null;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      lease.assertOwnedInTransaction(db);
      const stored = parseInstalledPluginIndexRow(readInstalledPluginIndexRow(db));
      const index = stored ? parseInstalledPluginIndex(stored.index) : null;
      if (!index) {
        return null;
      }
      const matches = (pluginId: string, installOwner: string, rootDir: string, hash: string) =>
        index.plugins.find(
          (plugin) =>
            plugin.pluginId === pluginId &&
            resolveInstalledPluginIndexInstallOwner(plugin) === installOwner &&
            plugin.rootDir === rootDir &&
            plugin.installRecordHash === hash,
        );
      for (const publication of changes.sourceSnapshots ?? []) {
        const plugin = matches(
          publication.pluginId,
          publication.installOwner,
          publication.rootDir,
          publication.descriptor.installRecordHash,
        );
        if (!plugin || Object.hasOwn(plugin, "sourceSnapshot")) {
          return null;
        }
      }
      for (const removal of changes.sourceSnapshotRemovals ?? []) {
        const plugin = matches(
          removal.pluginId,
          removal.installOwner,
          removal.rootDir,
          removal.installRecordHash,
        );
        if (
          !plugin ||
          !Object.hasOwn(plugin, "sourceSnapshot") ||
          !isDeepStrictEqual(plugin.sourceSnapshot, removal.expectedSnapshot)
        ) {
          return null;
        }
      }
      const receipt = writePersistedInstalledPluginIndexToSqlite(
        index,
        { database },
        lease,
        false,
        undefined,
        changes,
        // Lazy recapture must not erase the diagnostic before status/Doctor can see it.
        true,
      );
      return { ...receipt, index };
    },
    { database },
  );
}
