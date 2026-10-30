import fs from "node:fs";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import { runSqliteReadOnlyWorker } from "./sqlite-readonly-worker.js";
import { isSqliteSnapshotStagingName as isStagingName } from "./sqlite-snapshot-retirement.js";
import {
  sqliteSnapshotStagingParent,
  warnSqliteSnapshotReclamation,
} from "./sqlite-snapshot-staging.js";

const pendingReclamations = new Map<string, Promise<void>>();

export function reclaimAbandonedSqliteSnapshotsAsync(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
): Promise<void> {
  if (sqliteSnapshotStagingParent(root) || pendingReclamations.has(root)) {
    return pendingReclamations.get(root) ?? Promise.resolve();
  }
  const controller = new AbortController();
  const pass = retainSnapshotWork(
    (async () => {
      try {
        const entries = await fs.promises
          .readdir(root, { withFileTypes: true })
          .catch(() => undefined);
        // Empty passes need no process; the next maintenance pass observes later allocations.
        if (entries && !entries.some((entry) => entry.isDirectory() && isStagingName(entry.name))) {
          return;
        }
        if (!controller.signal.aborted) {
          for (const message of await runSqliteReadOnlyWorker(root, {
            mode: "reclaim",
            signal: controller.signal,
          })) {
            warnSqliteSnapshotReclamation(message);
          }
        }
      } catch (error) {
        warnSqliteSnapshotReclamation(
          "SQLite snapshot reclamation worker failed; continuing without cache cleanup.",
          error,
        );
      } finally {
        pendingReclamations.delete(root);
      }
    })(),
    () => controller.abort(new Error("SQLite snapshot reclamation owner stopped")),
  );
  pendingReclamations.set(root, pass);
  return pass;
}
