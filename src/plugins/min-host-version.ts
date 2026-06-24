// Checks plugin minimum host version compatibility.
import { compareOpenClawReleaseVersions } from "../infra/npm-registry-spec.js";
import { compareComparableSemver, parseComparableSemver } from "../infra/semver-compare.js";

/** Validation message for plugin minHostVersion manifest fields. */
export const MIN_HOST_VERSION_FORMAT =
  'openclaw.install.minHostVersion must use a semver floor in the form ">=x.y.z[-prerelease][+build]"';
const SEMVER_LABEL_RE = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const MIN_HOST_VERSION_RE = new RegExp(`^>=(${SEMVER_LABEL_RE})$`);
const LEGACY_MIN_HOST_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parsed plugin minimum host version requirement. */
export type MinHostVersionRequirement = {
  raw: string;
  minimumLabel: string;
};

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Result of checking a plugin minHostVersion against the current host. */
export type MinHostVersionCheckResult =
  | { ok: true; requirement: MinHostVersionRequirement | null }
  | { ok: false; kind: "invalid"; error: string }
  | { ok: false; kind: "unknown_host_version"; requirement: MinHostVersionRequirement }
  | {
      ok: false;
      kind: "incompatible";
      requirement: MinHostVersionRequirement;
      currentVersion: string;
    };

/** Parses a plugin minHostVersion manifest field. */
export function parseMinHostVersionRequirement(
  raw: unknown,
  options: { allowLegacyBareSemver?: boolean } = {},
): MinHostVersionRequirement | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const match =
    trimmed.match(MIN_HOST_VERSION_RE) ??
    (options.allowLegacyBareSemver ? trimmed.match(LEGACY_MIN_HOST_VERSION_RE) : null);
  if (!match) {
    return null;
  }
  const minimumLabel = match.length >= 4 ? `${match[1]}.${match[2]}.${match[3]}` : (match[1] ?? "");
  if (!parseComparableSemver(minimumLabel)) {
    return null;
  }
  return {
    raw: trimmed,
    minimumLabel,
  };
}

// Orders two host versions, returning <0 when `current` is older than `minimumLabel`. OpenClaw
// monthly-patch versions get channel-aware ordering: a numeric correction suffix (e.g. 2026.5.3-1)
// is a STABLE release that outranks its base, while -alpha/-beta are prereleases below it. Plain
// semver would wrongly rank -1 as a prerelease, so prefer the OpenClaw comparator and fall back to
// generic semver only for versions outside that format (build metadata, patch 0, non-OpenClaw).
function compareHostVersions(current: string, minimumLabel: string): number | null {
  const openclawOrder = compareOpenClawReleaseVersions(current, minimumLabel);
  if (openclawOrder !== null) {
    return openclawOrder;
  }
  return compareComparableSemver(
    parseComparableSemver(current),
    parseComparableSemver(minimumLabel),
  );
}

/** Checks whether the current host satisfies a plugin minHostVersion requirement. */
export function checkMinHostVersion(params: {
  currentVersion: string | undefined;
  minHostVersion: unknown;
  allowLegacyBareSemver?: boolean;
}): MinHostVersionCheckResult {
  if (params.minHostVersion === undefined) {
    return { ok: true, requirement: null };
  }
  const requirement = parseMinHostVersionRequirement(params.minHostVersion, {
    allowLegacyBareSemver: params.allowLegacyBareSemver,
  });
  if (!requirement) {
    return { ok: false, kind: "invalid", error: MIN_HOST_VERSION_FORMAT };
  }
  const currentVersion = normalizeOptionalString(params.currentVersion) || "unknown";
  if (!parseComparableSemver(currentVersion)) {
    return {
      ok: false,
      kind: "unknown_host_version",
      requirement,
    };
  }
  // A prerelease host (e.g. 2026.5.1-beta.1) must NOT satisfy a newer prerelease floor
  // (>=...-beta.3) or a stable floor (>=2026.5.1), but a stable correction host (2026.5.3-1) MUST
  // satisfy its base stable floor (>=2026.5.3). compareHostVersions encodes both rules.
  const comparison = compareHostVersions(currentVersion, requirement.minimumLabel);
  if (comparison !== null && comparison < 0) {
    return {
      ok: false,
      kind: "incompatible",
      requirement,
      currentVersion,
    };
  }
  return { ok: true, requirement };
}
