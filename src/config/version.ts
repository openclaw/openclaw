import {
  comparePrereleaseIdentifiers,
  normalizeLegacyDotBetaVersion,
} from "../infra/semver-compare.js";

export type MullusiVersion = {
  major: number;
  minor: number;
  patch: number;
  revision: number | null;
  prerelease: string[] | null;
};

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseMullusiVersion(raw: string | null | undefined): MullusiVersion | null {
  if (!raw) {
    return null;
  }
  const normalized = normalizeLegacyDotBetaVersion(raw.trim());
  const match = normalized.match(VERSION_RE);
  if (!match) {
    return null;
  }
  const [, major, minor, patch, suffix] = match;
  const revision = suffix && /^[0-9]+$/.test(suffix) ? Number.parseInt(suffix, 10) : null;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    revision,
    prerelease: suffix && revision == null ? suffix.split(".").filter(Boolean) : null,
  };
}

export function normalizeMullusiVersionBase(raw: string | null | undefined): string | null {
  const parsed = parseMullusiVersion(raw);
  if (!parsed) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function isSameMullusiStableFamily(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const parsedA = parseMullusiVersion(a);
  const parsedB = parseMullusiVersion(b);
  if (!parsedA || !parsedB) {
    return false;
  }
  if (parsedA.prerelease?.length || parsedB.prerelease?.length) {
    return false;
  }
  return (
    parsedA.major === parsedB.major &&
    parsedA.minor === parsedB.minor &&
    parsedA.patch === parsedB.patch
  );
}

export function compareMullusiVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const parsedA = parseMullusiVersion(a);
  const parsedB = parseMullusiVersion(b);
  if (!parsedA || !parsedB) {
    return null;
  }
  if (parsedA.major !== parsedB.major) {
    return parsedA.major < parsedB.major ? -1 : 1;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor < parsedB.minor ? -1 : 1;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1;
  }

  const rankA = releaseRank(parsedA);
  const rankB = releaseRank(parsedB);
  if (rankA !== rankB) {
    return rankA < rankB ? -1 : 1;
  }

  if (
    parsedA.revision != null &&
    parsedB.revision != null &&
    parsedA.revision !== parsedB.revision
  ) {
    return parsedA.revision < parsedB.revision ? -1 : 1;
  }

  if (parsedA.prerelease || parsedB.prerelease) {
    return comparePrereleaseIdentifiers(parsedA.prerelease, parsedB.prerelease);
  }

  return 0;
}

export function shouldWarnOnTouchedVersion(
  current: string | null | undefined,
  touched: string | null | undefined,
): boolean {
  const parsedCurrent = parseMullusiVersion(current);
  const parsedTouched = parseMullusiVersion(touched);
  if (
    parsedCurrent &&
    parsedTouched &&
    parsedCurrent.major === parsedTouched.major &&
    parsedCurrent.minor === parsedTouched.minor &&
    parsedCurrent.patch === parsedTouched.patch &&
    parsedTouched.revision != null
  ) {
    return false;
  }
  if (isSameMullusiStableFamily(current, touched)) {
    return false;
  }
  const cmp = compareMullusiVersions(current, touched);
  return cmp !== null && cmp < 0;
}

function releaseRank(version: MullusiVersion): number {
  if (version.prerelease?.length) {
    return 0;
  }
  if (version.revision != null) {
    return 2;
  }
  return 1;
}
