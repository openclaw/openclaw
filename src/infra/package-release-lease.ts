import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { ignoreMissingPath } from "./errno.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  resolvePackageReleaseSlotForRootSync,
} from "./package-release-slot-path.js";

/** Lease files name `<pid>-<process start>` under `releases/.leases/<release id>/`. */
export function packageReleaseLeaseDir(releasesDir: string, id: string): string {
  return path.join(releasesDir, ".leases", id);
}

export function readPackageReleaseLeases(
  prefix: string,
  id: string,
): { live: number; stale: string[] } {
  const dir = packageReleaseLeaseDir(path.join(prefix, PACKAGE_RELEASES_DIR), id);
  let names: string[];
  try {
    names = fsSync.readdirSync(dir);
  } catch (error) {
    ignoreMissingPath(error);
    return { live: 0, stale: [] };
  }
  let live = 0;
  const stale: string[] = [];
  for (const name of names) {
    const match = /^(\d+)-(\d+|unknown)-[0-9a-f]+$/u.exec(name);
    const pid = match ? Number(match[1]) : Number.NaN;
    // An unreadable lease name or start time keeps the release.
    const startedAt = match?.[2] === "unknown" ? null : Number(match?.[2]);
    if (!match || !isPidDefinitelyDead(pid)) {
      const current = match ? getFileLockProcessStartTime(pid) : null;
      if (!match || startedAt === null || current === null || current === startedAt) {
        live += 1;
        continue;
      }
    }
    stale.push(path.join(dir, name));
  }
  return { live, stale };
}

/**
 * A process that keeps loading files from its release holds it. The returned
 * function releases the lease; a lease left by a dead process is ignored.
 */
export function acquirePackageReleaseLease(runningRoot: string): () => void {
  const releaseGlobalRoot = path.dirname(fsSync.realpathSync.native(runningRoot));
  const releasePrefix = path.dirname(path.dirname(releaseGlobalRoot));
  const releasesDir = path.dirname(releasePrefix);
  // Only a release that a package link has selected; other `releases/` trees have their own owners.
  if (
    process.platform === "win32" ||
    path.basename(releasesDir) !== PACKAGE_RELEASES_DIR ||
    packageReleaseGlobalRoot(releasePrefix) !== releaseGlobalRoot ||
    !resolvePackageReleaseSlotForRootSync(runningRoot)
  ) {
    return () => {};
  }
  const dir = packageReleaseLeaseDir(releasesDir, path.basename(releasePrefix));
  // One process can register more than once; each registration owns its own file.
  const lease = path.join(
    dir,
    `${process.pid}-${getFileLockProcessStartTime(process.pid) ?? "unknown"}-${randomBytes(4).toString("hex")}`,
  );
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(lease, "");
  return () => fsSync.rmSync(lease, { force: true });
}
