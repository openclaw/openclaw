import {
  comparePrereleaseIdentifiers,
  normalizeLegacyDotBetaVersion,
} from "../infra/semver-compare.js";

export type OpenClawVersion = {
  major: number;
  minor: number;
  patch: number;
  revision: number | null;
  prerelease: string[] | null;
};

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseOpenClawVersion(raw: string | null | undefined): OpenClawVersion | null {
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

export function normalizeOpenClawVersionBase(raw: string | null | undefined): string | null {
  const parsed = parseOpenClawVersion(raw);
  if (!parsed) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function isSameOpenClawStableFamily(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const parsedA = parseOpenClawVersion(a);
  const parsedB = parseOpenClawVersion(b);
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

export function compareOpenClawVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const parsedA = parseOpenClawVersion(a);
  const parsedB = parseOpenClawVersion(b);
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
  const parsedCurrent = parseOpenClawVersion(current);
  const parsedTouched = parseOpenClawVersion(touched);
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
  if (isSameOpenClawStableFamily(current, touched)) {
    return false;
  }
  const cmp = compareOpenClawVersions(current, touched);
  return cmp !== null && cmp < 0;
}

/** Structured result from a version skew check at config load time. */
export type VersionSkewResult = {
  /** True when the config was last written by a newer OpenClaw version. */
  skewed: boolean;
  /** Human-readable warning message (only set when skewed). */
  message: string | null;
  /** Actionable guidance for the user (only set when skewed). */
  guidance: string | null;
  /** The version that last touched the config (null if unknown). */
  configVersion: string | null;
  /** The running binary version. */
  currentVersion: string;
};

/**
 * Check whether the loaded config was written by a newer OpenClaw version
 * and return a structured result with actionable guidance.
 */
export function checkVersionSkew(
  currentVersion: string,
  touchedVersion: string | null | undefined,
): VersionSkewResult {
  if (!touchedVersion) {
    return {
      skewed: false,
      message: null,
      guidance: null,
      configVersion: null,
      currentVersion,
    };
  }
  const skewed = shouldWarnOnTouchedVersion(currentVersion, touchedVersion);
  if (!skewed) {
    return {
      skewed: false,
      message: null,
      guidance: null,
      configVersion: touchedVersion,
      currentVersion,
    };
  }
  return {
    skewed: true,
    message: `Config was last written by a newer OpenClaw (${touchedVersion}); current version is ${currentVersion}.`,
    guidance: "Run `openclaw update` to update, or `openclaw doctor` to check compatibility.",
    configVersion: touchedVersion,
    currentVersion,
  };
}

function releaseRank(version: OpenClawVersion): number {
  if (version.prerelease?.length) {
    return 0;
  }
  if (version.revision != null) {
    return 2;
  }
  return 1;
}
