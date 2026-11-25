import fs from "node:fs";
import path from "node:path";

/**
 * On a prefix OpenClaw owns, the package path is a link to one release, which keeps
 * the package at the same path below its own directory:
 * npm: `<prefix>/lib/node_modules/<name> -> <prefix>/releases/<id>/lib/node_modules/<name>`;
 * Git: `<prefix>/<name> -> <prefix>/releases/<id>/<name>`, outside any `node_modules`, where
 * Node refuses to strip the types of the release's plugin sources (#201874).
 * The link is the only record of which release is selected. On Windows the link is an
 * NTFS directory junction, which needs no administrator rights. Only the Git install
 * layout uses it there: Windows npm launchers are files, so npm keeps a plain package
 * directory (`resolvePackageReleaseTarget`).
 */
export const PACKAGE_RELEASES_DIR = "releases";

export type PackageReleaseSlot = {
  /** The link's own path, with its parent resolved. */
  slot: string;
  prefix: string;
  releaseId: string;
  releasePrefix: string;
  /** The package directory inside the selected release. */
  releaseRoot: string;
  target: string;
};

/** npm's POSIX global layout: `<prefix>/lib/node_modules/<name>`. */
export function packageReleaseGlobalRoot(prefix: string): string {
  return path.join(prefix, "lib", "node_modules");
}

function prefixOfGlobalRoot(globalRoot: string): string | null {
  const lib = path.dirname(globalRoot);
  return path.basename(globalRoot) === "node_modules" && path.basename(lib) === "lib"
    ? path.dirname(lib)
    : null;
}

/**
 * The release directory a path lies in: the nearest ancestor whose parent is `releases/`.
 * A release keeps its package where the link sits below the install prefix.
 */
export function packageReleasePrefixOfRoot(root: string): string | null {
  for (let dir = path.dirname(root); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (path.basename(path.dirname(dir)) === PACKAGE_RELEASES_DIR) {
      return dir;
    }
  }
  return null;
}

/**
 * Recognize a package path that is a link into a release of the same prefix and owner.
 * An operator's `npm link` to a checkout, or a plain directory, is not a release slot.
 */
export function readPackageReleaseSlotSync(packagePath: string): PackageReleaseSlot | null {
  try {
    const absolute = path.resolve(packagePath);
    const link = fs.lstatSync(absolute);
    if (!link.isSymbolicLink()) {
      return null;
    }
    const slot = path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
    // npm keeps its link at `lib/node_modules/<name>`; a Git install keeps it at `<name>`.
    const prefix = prefixOfGlobalRoot(path.dirname(slot)) ?? path.dirname(slot);
    const releaseRoot = fs.realpathSync.native(slot);
    const releasesDir = path.join(prefix, PACKAGE_RELEASES_DIR);
    const releaseId = path.relative(releasesDir, releaseRoot).split(path.sep)[0];
    if (
      !releaseId ||
      releaseId.startsWith(".") ||
      releaseRoot !== path.join(releasesDir, releaseId, path.relative(prefix, slot))
    ) {
      return null;
    }
    const releasePrefix = path.join(releasesDir, releaseId);
    const owner = fs.statSync(prefix).uid;
    if (
      link.uid !== owner ||
      fs.statSync(releasesDir).uid !== owner ||
      fs.statSync(releasePrefix).uid !== owner ||
      !fs.statSync(releaseRoot).isDirectory()
    ) {
      return null;
    }
    return { slot, prefix, releaseId, releasePrefix, releaseRoot, target: fs.readlinkSync(slot) };
  } catch {
    return null;
  }
}

/** The stable package path of a root running from a release, while the link still names it. */
export function resolvePackageReleaseSlotForRootSync(root: string): string | null {
  const resolved = path.resolve(root);
  const releasePrefix = packageReleasePrefixOfRoot(resolved);
  if (!releasePrefix) {
    return null;
  }
  const prefix = path.dirname(path.dirname(releasePrefix));
  const slot = readPackageReleaseSlotSync(
    path.join(prefix, path.relative(releasePrefix, resolved)),
  );
  try {
    return slot && slot.releaseRoot === fs.realpathSync.native(resolved) ? slot.slot : null;
  } catch {
    return null;
  }
}
