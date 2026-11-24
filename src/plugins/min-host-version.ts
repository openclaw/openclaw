import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { valid as validSemver } from "semver";
import { compareOpenClawVersions } from "../config/version.js";

/** Validation message for plugin minHostVersion manifest fields. */
const MIN_HOST_VERSION_FORMAT =
  'openclaw.install.minHostVersion must use a semver floor in the form ">=x.y.z[-prerelease][+build]"';
const SEMVER_LABEL_RE = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const MIN_HOST_VERSION_RE = new RegExp(`^>=(${SEMVER_LABEL_RE})$`);
const LEGACY_MIN_HOST_VERSION_RE = new RegExp(`^(${SEMVER_LABEL_RE})$`);

/** Parses a plugin minHostVersion manifest field. */
export function parseMinHostVersionRequirement(
  raw: unknown,
  options: { allowLegacyBareSemver?: boolean } = {},
) {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  const match =
    trimmed.match(MIN_HOST_VERSION_RE) ??
    (options.allowLegacyBareSemver ? trimmed.match(LEGACY_MIN_HOST_VERSION_RE) : null);
  if (!match) {
    return null;
  }
  const minimumLabel = match[1] ?? "";
  if (!validSemver(minimumLabel)) {
    return null;
  }
  return {
    raw: trimmed,
    minimumLabel,
  };
}

/** Checks whether the current host satisfies a plugin minHostVersion requirement. */
export function checkMinHostVersion(params: {
  currentVersion: string | undefined;
  minHostVersion: unknown;
  allowLegacyBareSemver?: boolean;
}) {
  if (params.minHostVersion === undefined) {
    return { ok: true as const, requirement: null };
  }
  const requirement = parseMinHostVersionRequirement(params.minHostVersion, {
    allowLegacyBareSemver: params.allowLegacyBareSemver,
  });
  if (!requirement) {
    return { ok: false as const, kind: "invalid" as const, error: MIN_HOST_VERSION_FORMAT };
  }
  const currentVersion = normalizeOptionalString(params.currentVersion) || "unknown";
  const comparison = compareOpenClawVersions(currentVersion, requirement.minimumLabel);
  if (comparison === null) {
    return {
      ok: false as const,
      kind: "unknown_host_version" as const,
      requirement,
    };
  }
  if (comparison < 0) {
    return {
      ok: false as const,
      kind: "incompatible" as const,
      requirement,
      currentVersion,
    };
  }
  return { ok: true as const, requirement };
}
