import { readRootJsonObjectSync } from "@openclaw/fs-safe/json";
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
  if (!value) {
    return false;
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at >= value.length - 1) {
    return false;
  }
  const version = value.slice(at + 1).trim();
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
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
