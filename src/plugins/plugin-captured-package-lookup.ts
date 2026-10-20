import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
type CapturedPackageOwner = {
  sourceRoot: string;
  capturedRoot: string;
  links: ReadonlySet<string>;
};
export const isPluginPackageFile = (root: string, file: string) =>
  isPathInside(root, file) && !path.relative(root, file).split(path.sep).includes("node_modules");

function isCapturedPathInside(root: string, file: string): boolean {
  return process.platform === "win32"
    ? isPathInside(root, file)
    : file === root ||
        (file.startsWith(root) && (root.endsWith("/") || file.charCodeAt(root.length) === 47));
}

function isCapturedPackageFile(root: string, file: string): boolean {
  if (process.platform === "win32") {
    return isPluginPackageFile(root, file);
  }
  return (
    isCapturedPathInside(root, file) &&
    !/(?:^|\/)node_modules(?:\/|$)/u.test(file.slice(root.length))
  );
}

/** Retain the matched lookup root; dependency links need their own source-relative mapping. */
export function findPluginCapturedPackage<Owner extends CapturedPackageOwner>(
  packages: ReadonlyMap<string, Owner>,
  filename: string,
  directory: string,
  capturedOwners?: ReadonlyMap<string, Owner>,
) {
  // The artifact producer normalizes its directory, captured roots, and dependency links.
  const file = process.platform === "win32" ? filename : path.resolve(filename);
  if (!isCapturedPathInside(directory, file)) {
    return undefined;
  }
  // The producer records exact private destinations after their source boundary check.
  // This is an ownership index, not a cache of mutable dependency-link lookups.
  const capturedOwner = capturedOwners?.get(file);
  if (
    capturedOwner &&
    packages.get(capturedOwner.sourceRoot) === capturedOwner &&
    isCapturedPackageFile(capturedOwner.capturedRoot, file)
  ) {
    return { owner: capturedOwner, root: capturedOwner.capturedRoot };
  }
  for (const owner of packages.values()) {
    if (isCapturedPackageFile(owner.capturedRoot, file)) {
      return { owner, root: owner.capturedRoot };
    }
    for (const root of owner.links) {
      if (isCapturedPackageFile(root, file)) {
        return { owner, root };
      }
    }
  }
  return undefined;
}
