import fs from "node:fs";
import path from "node:path";

/** Resolve the canonical identity of an update checkout/install root. */
export function resolveUpdateInstallRoot(root: string): string {
  const absolute = path.resolve(root);
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

export function updateInstallRootsMatch(left: string, right: string): boolean {
  return resolveUpdateInstallRoot(left) === resolveUpdateInstallRoot(right);
}
