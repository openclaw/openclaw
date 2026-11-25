import fs from "node:fs";
import path from "node:path";
import {
  readPackageReleaseSlotSync,
  resolvePackageReleaseSlotForRootSync,
} from "./package-release-slot-path.js";

/**
 * Resolve the canonical identity of an update checkout/install root. A release
 * link is the installation itself, so its identity stays the same across a
 * switch, and the release it currently selects is the same installation by its
 * real path (where a process finds its own root). A published updater on a
 * linked root keys by the release path instead; executor grants accept either
 * spelling through `updateInstallRootsMatch`.
 */
export function resolveUpdateInstallRoot(root: string): string {
  const absolute = path.resolve(root);
  const releaseSlot =
    readPackageReleaseSlotSync(absolute)?.slot ?? resolvePackageReleaseSlotForRootSync(absolute);
  if (releaseSlot) {
    return releaseSlot;
  }
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    try {
      if (!fs.lstatSync(absolute, { throwIfNoEntry: false })) {
        return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
      }
    } catch {}
    return absolute;
  }
}

/** Same installation, including a release link and the release it currently selects. */
export function updateInstallRootsMatch(left: string, right: string): boolean {
  const [a, b] = [resolveUpdateInstallRoot(left), resolveUpdateInstallRoot(right)];
  return (
    a === b ||
    resolvePackageReleaseSlotForRootSync(a) === b ||
    resolvePackageReleaseSlotForRootSync(b) === a
  );
}
