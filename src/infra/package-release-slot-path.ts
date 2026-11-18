import fs from "node:fs";
import path from "node:path";

/**
 * On an OpenClaw-owned npm prefix the package path is a link to one release:
 * `<prefix>/lib/node_modules/<name> -> <prefix>/releases/<id>/lib/node_modules/<name>`.
 * The link is the only record of which release is selected. POSIX only: Windows
 * launchers are files, so Windows keeps a plain package directory.
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
 * Recognize a package path that is a link into a release of the same prefix and owner.
 * An operator's `npm link` to a checkout, or a plain directory, is not a release slot.
 */
export function readPackageReleaseSlotSync(packagePath: string): PackageReleaseSlot | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const absolute = path.resolve(packagePath);
    const link = fs.lstatSync(absolute);
    if (!link.isSymbolicLink()) {
      return null;
    }
    const slot = path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
    const prefix = prefixOfGlobalRoot(path.dirname(slot));
    if (!prefix) {
      return null;
    }
    const releaseRoot = fs.realpathSync.native(slot);
    const releasesDir = path.join(prefix, PACKAGE_RELEASES_DIR);
    const releaseId = path.relative(releasesDir, releaseRoot).split(path.sep)[0];
    if (
      !releaseId ||
      releaseId.startsWith(".") ||
      releaseRoot !==
        path.join(packageReleaseGlobalRoot(path.join(releasesDir, releaseId)), path.basename(slot))
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
  if (process.platform === "win32") {
    return null;
  }
  const resolved = path.resolve(root);
  const releasePrefix = prefixOfGlobalRoot(path.dirname(resolved));
  const releasesDir = releasePrefix && path.dirname(releasePrefix);
  if (!releasesDir || path.basename(releasesDir) !== PACKAGE_RELEASES_DIR) {
    return null;
  }
  const slot = readPackageReleaseSlotSync(
    path.join(packageReleaseGlobalRoot(path.dirname(releasesDir)), path.basename(resolved)),
  );
  try {
    return slot && slot.releaseRoot === fs.realpathSync.native(resolved) ? slot.slot : null;
  } catch {
    return null;
  }
}
