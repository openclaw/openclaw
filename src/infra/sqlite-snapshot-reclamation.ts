import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { retireSqliteSnapshotPayload } from "./sqlite-readonly-location-cleanup.js";
import {
  beginSqliteSnapshotRetirement,
  SQLITE_SNAPSHOT_PREFIX,
} from "./sqlite-snapshot-retirement.js";

export type SqliteSnapshotReclamation = { removed: number; bytes: number; skipped: number };
const GRACE_MS = 15 * 60_000;

/** Only new install-scoped roots are automatic; shared-cache and updater roots stay offline. */
export async function reclaimAbandonedSqliteSnapshots(
  signal: AbortSignal,
): Promise<SqliteSnapshotReclamation> {
  const root = resolvePrivateSqliteSnapshotStagingRoot();
  const empty = { removed: 0, bytes: 0, skipped: 0 };
  if (!/^sqlite-[a-f0-9]{24}$/u.test(path.basename(root))) {
    return empty;
  }
  // Avoid a native worker when the installation has never needed a private copy.
  const entries = await fs.promises.opendir(root);
  for await (const entry of entries) {
    if (signal.aborted) {
      return empty;
    }
    if (entry.isDirectory() && entry.name.startsWith(SQLITE_SNAPSHOT_PREFIX)) {
      const { runSqliteReadOnlyWorkerOnce } = await import("./sqlite-readonly-worker.js");
      return await runSqliteReadOnlyWorkerOnce(root, { mode: "staging-sweep", signal });
    }
    await setImmediate();
  }
  return empty;
}

/** The native worker holds every existing lifetime token across bounded payload deletion. */
export async function reclaimSqliteSnapshotsInProcess(
  root: string,
): Promise<SqliteSnapshotReclamation> {
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    !/^sqlite-[a-f0-9]{24}$/u.test(path.basename(root))
  ) {
    throw new Error("SQLite snapshot reclamation requires an install-scoped private root");
  }
  const result = { removed: 0, bytes: 0, skipped: 0 };
  const cutoff = Date.now() - GRACE_MS;
  const entries = await fs.promises.opendir(root);
  for await (const entry of entries) {
    // A fixed prefix budget would revisit retained entries forever and starve later copies.
    await setImmediate();
    if (!entry.isDirectory() || !entry.name.startsWith(SQLITE_SNAPSHOT_PREFIX)) {
      continue;
    }
    const directory = path.join(root, entry.name);
    try {
      const retirement = beginSqliteSnapshotRetirement(directory, { cutoff, allowLegacy: false });
      try {
        for (const _ of retireSqliteSnapshotPayload(retirement)) {
          await setImmediate();
        }
        fs.rmSync(directory, { recursive: true });
        result.removed++;
        result.bytes += retirement.bytes;
      } finally {
        retirement.release();
      }
    } catch {
      // Busy, young, missing-token and unknown layouts remain for the next pass or operator.
      result.skipped++;
    }
  }
  return result;
}
