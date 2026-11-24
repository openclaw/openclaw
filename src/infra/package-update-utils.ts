import { readRootJsonObjectSync } from "@openclaw/fs-safe/json";
import { valid as validSemver } from "semver";
import { compareOpenClawReleaseVersions } from "./npm-registry-spec.js";
import { compareValidSemver } from "./semver.js";

export function comparePackageUpdateVersions(left: string, right: string): number {
  const releaseCmp = compareOpenClawReleaseVersions(left, right);
  if (releaseCmp !== null) {
    return releaseCmp;
  }
  return compareValidSemver(left, right) ?? 0;
}

export function isPackageVersionDowngrade(
  currentVersion: string | undefined,
  nextVersion: string | undefined,
): boolean {
  if (!currentVersion || !nextVersion) {
    return false;
  }
  return comparePackageUpdateVersions(nextVersion, currentVersion) < 0;
}

export function expectedIntegrityForUpdate(
  spec: string | undefined,
  integrity: string | undefined,
): string | undefined {
  if (!integrity || !spec) {
    return undefined;
  }
  const value = spec.trim();
  const at = value.lastIndexOf("@");
  // npm's loose SemVer versions are pinned; a version-like dist tag can move.
  return at > 0 && validSemver(value.slice(at + 1).trim(), true) !== null ? integrity : undefined;
}

export function readInstalledPackageManifest(dir: string): Record<string, unknown> | undefined {
  const result = readRootJsonObjectSync({
    rootDir: dir,
    relativePath: "package.json",
    boundaryLabel: "installed package directory",
  });
  return result.ok ? result.value : undefined;
}

export async function readInstalledPackageVersion(dir: string): Promise<string | undefined> {
  const manifest = readInstalledPackageManifest(dir);
  return typeof manifest?.version === "string" ? manifest.version : undefined;
}
