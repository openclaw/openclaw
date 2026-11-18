import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { readPackageReleaseLeases, packageReleaseLeaseDir } from "./package-release-lease.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  readPackageReleaseSlotSync,
} from "./package-release-slot-path.js";
import { readPackageReleaseIdentity, type PackageReleaseIdentity } from "./package-release-slot.js";
import type { UpdateRunRecord } from "./update-run-record.js";

/** Covers a process that started from a release but has not taken its lease yet. */
export const PACKAGE_RELEASE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export type PackageReleaseEntry = PackageReleaseIdentity & {
  id: string;
  selected: boolean;
  leased: boolean;
};

const releasesDirOf = (prefix: string) => path.join(prefix, PACKAGE_RELEASES_DIR);

/** Releases under the prefix, newest first, with what keeps each one. */
export async function listPackageReleases(slot: string): Promise<PackageReleaseEntry[]> {
  const selected = readPackageReleaseSlotSync(slot);
  if (!selected) {
    return [];
  }
  const releasesDir = releasesDirOf(selected.prefix);
  const entries: (PackageReleaseEntry & { changedAt: number })[] = [];
  for (const id of await fs.readdir(releasesDir)) {
    if (id.startsWith(".")) {
      continue;
    }
    const root = path.join(
      packageReleaseGlobalRoot(path.join(releasesDir, id)),
      path.basename(slot),
    );
    const identity = await readPackageReleaseIdentity(root).catch(() => null);
    const stat = await fs.stat(path.join(releasesDir, id)).catch(() => null);
    if (!identity || !stat) {
      continue;
    }
    entries.push({
      ...identity,
      id,
      selected: id === selected.releaseId,
      leased: readPackageReleaseLeases(selected.prefix, id).live > 0,
      changedAt: stat.mtimeMs,
    });
  }
  return entries
    .toSorted((left, right) => right.changedAt - left.changedAt)
    .map(({ changedAt: _changedAt, ...entry }) => entry);
}

function namedBy(run: UpdateRunRecord): string[] {
  const release = run.origin.packageRelease;
  return release ? [release.from.path, release.to.path] : [];
}

/**
 * Remove a release only when the link does not name it, no lease holds it, no
 * open update run names it, and it was neither selected nor changed in the last
 * 24 hours. A switch stamps the release it deselects. Any doubt keeps the files.
 */
export async function collectPackageReleases(params: {
  slot: string;
  prefix: string;
  /** Releases this process still runs or recovers from. */
  keep?: readonly string[];
  readOpenRuns?: () => Promise<UpdateRunRecord[]>;
  now?: number;
}): Promise<{ removed: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const removed: string[] = [];
  const selected = readPackageReleaseSlotSync(params.slot);
  if (!selected || selected.prefix !== params.prefix) {
    return { removed, warnings };
  }
  const now = params.now ?? Date.now();
  let openRuns: UpdateRunRecord[];
  try {
    openRuns = await (
      params.readOpenRuns ??
      (async () => {
        const { listUpdateRunsAsync } = await import("./update-run-reader.js");
        return await listUpdateRunsAsync({ active: true });
      })
    )();
  } catch (error) {
    return {
      removed,
      warnings: [
        `Release collection skipped; open update runs are unreadable: ${formatErrorMessage(error)}`,
      ],
    };
  }
  const kept = new Set(
    [...(params.keep ?? []), ...openRuns.flatMap(namedBy)].map((root) => path.resolve(root)),
  );
  const releasesDir = releasesDirOf(selected.prefix);
  const ids = await fs.readdir(releasesDir);
  for (const leftover of ids.filter((id) => id.startsWith(".collecting-"))) {
    await fs.rm(path.join(releasesDir, leftover), { recursive: true, force: true });
  }
  for (const id of ids) {
    if (id.startsWith(".") || id === selected.releaseId) {
      continue;
    }
    const releasePrefix = path.join(releasesDir, id);
    const root = path.join(packageReleaseGlobalRoot(releasePrefix), path.basename(selected.slot));
    const stat = await fs.lstat(releasePrefix).catch(ignoreMissingPath);
    const leases = readPackageReleaseLeases(selected.prefix, id);
    if (
      !stat?.isDirectory() ||
      kept.has(root) ||
      leases.live > 0 ||
      now - stat.mtimeMs < PACKAGE_RELEASE_MIN_AGE_MS
    ) {
      continue;
    }
    // Move it out of the release namespace first, so a partial removal is never a release.
    const doomed = path.join(releasesDir, `.collecting-${id}-${randomBytes(4).toString("hex")}`);
    try {
      await fs.rename(releasePrefix, doomed);
      await fs.rm(doomed, { recursive: true, force: true });
      for (const lease of leases.stale) {
        await fs.rm(lease, { force: true });
      }
      await fs.rm(packageReleaseLeaseDir(releasesDir, id), { recursive: true, force: true });
      removed.push(releasePrefix);
    } catch (error) {
      warnings.push(`Could not remove release ${releasePrefix}: ${formatErrorMessage(error)}`);
    }
  }
  return { removed, warnings };
}
