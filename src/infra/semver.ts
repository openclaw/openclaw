import { compareBuild, parse, type SemVer } from "semver";

const RELEASE_PREFIX_RE = /^\d{4}\./;

export function compareValidSemver(left: string, right: string): number | null {
  const parsedLeft = parse(left);
  const parsedRight = parse(right);
  return parsedLeft && parsedRight ? parsedLeft.compare(parsedRight) : null;
}

export function isOpenClawCorrectionSemver(version: SemVer): boolean {
  return version.prerelease.length === 1 && typeof version.prerelease[0] === "number";
}

function toOpenClawComparableVersion(version: SemVer): string {
  if (isOpenClawCorrectionSemver(version)) {
    return `${version.major}.${version.minor}.${version.patch}+${version.prerelease[0]}`;
  }
  // SemVer.version excludes build metadata, which remains precedence-neutral.
  return version.version;
}

/** Compares prereleases, stable releases, then OpenClaw numeric corrections. */
export function compareOpenClawSemver(left: SemVer, right: SemVer): number {
  return compareBuild(toOpenClawComparableVersion(left), toOpenClawComparableVersion(right));
}

/** Parses OpenClaw's monthly patch stable/alpha/beta/correction version format. */
export function parseOpenClawReleaseVersion(value: string): SemVer | null {
  const trimmed = value.trim();
  const parsed = RELEASE_PREFIX_RE.test(trimmed) ? parse(trimmed) : null;
  if (!parsed || parsed.build.length > 0) {
    return null;
  }
  if (parsed.minor < 1 || parsed.minor > 12 || parsed.patch < 1) {
    return null;
  }

  const [label, sequence] = parsed.prerelease;
  const isStable = parsed.prerelease.length === 0;
  const isCorrection = isOpenClawCorrectionSemver(parsed) && typeof label === "number" && label > 0;
  const isPrerelease =
    parsed.prerelease.length === 2 &&
    (label === "alpha" || label === "beta") &&
    typeof sequence === "number" &&
    sequence > 0;
  if (!isStable && !isCorrection && !isPrerelease) {
    return null;
  }
  return parsed;
}

/** Compares OpenClaw monthly patch release versions across alpha, beta, stable, and corrections. */
export function compareOpenClawReleaseVersions(left: string, right: string): number | null {
  const parsedLeft = parseOpenClawReleaseVersion(left);
  const parsedRight = parseOpenClawReleaseVersion(right);
  return parsedLeft && parsedRight ? compareOpenClawSemver(parsedLeft, parsedRight) : null;
}

/** Null leaves unknown-version handling to the caller. */
export function isRuntimeAdmissibleForFloor(
  runtimeVersion: string,
  hostVersion: string,
  minimum: string,
): boolean | null {
  const comparison = compareOpenClawReleaseVersions(runtimeVersion, minimum);
  // Exact pairs are compatible by construction, even below a later SDK floor.
  // Accepted dev-only mix: main still carrying the last stable version string
  // with a separately installed published runtime of that version can fail at import.
  return comparison === null ? null : runtimeVersion === hostVersion || comparison >= 0;
}

/** Converts legacy OpenClaw `1.2.3.beta.N` tags into valid SemVer prereleases. */
export function normalizeLegacyDotBetaVersion(version: string): string {
  const trimmed = version.trim();
  const dotBetaMatch = /^([vV]?[0-9]+\.[0-9]+\.[0-9]+)\.beta(?:\.([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!dotBetaMatch) {
    return trimmed;
  }
  const base = dotBetaMatch[1];
  const suffix = dotBetaMatch[2];
  return suffix ? `${base}-beta.${suffix}` : `${base}-beta`;
}
