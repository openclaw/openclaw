import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { retireSqliteSnapshotPayload } from "./sqlite-readonly-location-cleanup.js";
import {
  beginSqliteSnapshotRetirement,
  SQLITE_SNAPSHOT_LEGACY_AGE_MS,
  SQLITE_SNAPSHOT_PREFIX,
} from "./sqlite-snapshot-retirement.js";

export type SqliteSnapshotReclamation = { removed: number; bytes: number; skipped: number };
const GRACE_MS = 15 * 60_000;
const NAMESPACE = /^sqlite-[a-f0-9]{24}$/u;

/** Updater roots stay offline; copies outside this namespace are reclaimed only after a day idle. */
export async function reclaimAbandonedSqliteSnapshots(
  signal: AbortSignal,
): Promise<SqliteSnapshotReclamation> {
  const root = resolvePrivateSqliteSnapshotStagingRoot();
  const result = { removed: 0, bytes: 0, skipped: 0 };
  if (!NAMESPACE.test(path.basename(root))) {
    return result;
  }
  const sweep = async (directory: string) => {
    // Avoid a native worker when a root has never needed a private copy.
    if (!(await hasSnapshotEntries(directory, signal))) {
      return;
    }
    const { runSqliteReadOnlyWorkerOnce } = await import("./sqlite-readonly-worker.js");
    const swept = await runSqliteReadOnlyWorkerOnce(directory, { mode: "staging-sweep", signal });
    result.removed += swept.removed;
    result.bytes += swept.bytes;
    result.skipped += swept.skipped;
  };
  await sweep(root);
  // Runs staged under another state directory (Doctor's private state copy, older
  // releases) left copies in sibling namespaces or the shared parent. Nothing else
  // reclaims them; lifetime tokens still fence every live owner and reader.
  const parent = path.dirname(root);
  try {
    const siblings: string[] = [];
    for await (const entry of await fs.promises.opendir(parent)) {
      if (entry.isDirectory() && NAMESPACE.test(entry.name) && entry.name !== path.basename(root)) {
        siblings.push(path.join(parent, entry.name));
      }
    }
    for (const directory of [...siblings, parent]) {
      if (signal.aborted) {
        break;
      }
      await sweep(directory).catch(() => {
        result.skipped++;
      });
    }
  } catch {
    result.skipped++;
  }
  return result;
}

async function hasSnapshotEntries(directory: string, signal: AbortSignal): Promise<boolean> {
  for await (const entry of await fs.promises.opendir(directory)) {
    if (signal.aborted) {
      return false;
    }
    if (entry.isDirectory() && entry.name.startsWith(SQLITE_SNAPSHOT_PREFIX)) {
      return true;
    }
    await setImmediate();
  }
  return false;
}

/** The native worker holds every existing lifetime token across bounded payload deletion. */
export async function reclaimSqliteSnapshotsInProcess(
  root: string,
): Promise<SqliteSnapshotReclamation> {
  const own = resolvePrivateSqliteSnapshotStagingRoot();
  const stat = fs.lstatSync(root);
  // Accept this installation's namespace, a sibling namespace, or their shared parent.
  const stranded =
    root === path.dirname(own) ||
    (path.dirname(root) === path.dirname(own) && NAMESPACE.test(path.basename(root)));
  if (
    !stat.isDirectory() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    !NAMESPACE.test(path.basename(own)) ||
    (root !== own && !stranded)
  ) {
    throw new Error("SQLite snapshot reclamation requires an install-scoped private root");
  }
  const result = { removed: 0, bytes: 0, skipped: 0 };
  // Another installation may still be between allocation and first use, so
  // copies outside our namespace must be idle for a full day.
  const cutoff = Date.now() - (root === own ? GRACE_MS : SQLITE_SNAPSHOT_LEGACY_AGE_MS);
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
