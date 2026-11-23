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

export function isPinnedRegistrySpec(spec: string): boolean {
  const value = spec.trim();
  const at = value.lastIndexOf("@");
  // Match npm-package-arg's loose SemVer rules: version-like tags can move,
  // while loose exact versions must retain their recorded integrity.
  return at > 0 && validSemver(value.slice(at + 1).trim(), true) !== null;
}

export function expectedIntegrityForUpdate(
  spec: string | undefined,
  integrity: string | undefined,
): string | undefined {
  return integrity && spec && isPinnedRegistrySpec(spec) ? integrity : undefined;
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
