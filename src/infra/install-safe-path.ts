// Provides safe path helpers for plugin installation targets.
import fs from "node:fs/promises";
import path from "node:path";

export {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
} from "@openclaw/fs-safe/advanced";

/** Returns the package basename for scoped npm names while preserving plain ids. */
export function unscopedPackageName(name: string): string {
  const trimmed = name.trim();
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Matches a requested install id against either the full package name or unscoped basename. */
export function packageNameMatchesId(packageName: string, id: string): boolean {
  const trimmedId = id.trim();
  if (!trimmedId) {
    return false;
  }

  const trimmedPackageName = packageName.trim();
  if (!trimmedPackageName) {
    return false;
  }

  return trimmedId === trimmedPackageName || trimmedId === unscopedPackageName(trimmedPackageName);
}

export const INSTALL_BASE_CHANGED_ERROR_MESSAGE = "install base directory changed during install";

export async function assertInstallBaseStable(params: {
  installBaseDir: string;
  expectedRealPath: string;
}): Promise<void> {
  const baseStat = await fs.stat(params.installBaseDir);
  if (!baseStat.isDirectory()) {
    throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
  }
  const currentRealPath = await fs.realpath(params.installBaseDir);
  if (currentRealPath !== params.expectedRealPath) {
    throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
  }
}

export async function resolveInstallPublishTarget(params: {
  installBaseDir: string;
  targetDir: string;
}): Promise<{ installBaseRealPath: string; canonicalTargetDir: string }> {
  const installBaseResolved = path.resolve(params.installBaseDir);
  const targetResolved = path.resolve(params.targetDir);
  const targetRelativePath = path.relative(installBaseResolved, targetResolved);
  if (
    !targetRelativePath ||
    targetRelativePath === ".." ||
    targetRelativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error("invalid install target path");
  }
  const installBaseRealPath = await fs.realpath(params.installBaseDir);
  return {
    installBaseRealPath,
    canonicalTargetDir: path.join(installBaseRealPath, targetRelativePath),
  };
}
