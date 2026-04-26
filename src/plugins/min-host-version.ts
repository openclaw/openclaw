import { normalizeOptionalString } from "../shared/string-coerce.js";
import { satisfies, validRange, validSemver } from "./semver.runtime.js";

export const MIN_HOST_VERSION_FORMAT =
  'openclaw.install.minHostVersion must use a semver floor in the form ">=x.y.z" or ">=x.y.z-prerelease"';
const MIN_HOST_VERSION_RE = /^>=(\S+)$/;

export type MinHostVersionRequirement = {
  raw: string;
  minimumLabel: string;
};

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

export function parseMinHostVersionRequirement(raw: unknown): MinHostVersionRequirement | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(MIN_HOST_VERSION_RE);
  if (!match) {
    return null;
  }
  const minimumLabel = match[1] ?? "";
  if (!validSemver(minimumLabel) || !validRange(trimmed)) {
    return null;
  }
  return {
    raw: trimmed,
    minimumLabel,
  };
}

export function validateMinHostVersion(raw: unknown): string | null {
  if (raw === undefined) {
    return null;
  }
  return parseMinHostVersionRequirement(raw) ? null : MIN_HOST_VERSION_FORMAT;
}

export function checkMinHostVersion(params: {
  currentVersion: string | undefined;
  minHostVersion: unknown;
}): MinHostVersionCheckResult {
  if (params.minHostVersion === undefined) {
    return { ok: true, requirement: null };
  }
  const requirement = parseMinHostVersionRequirement(params.minHostVersion);
  if (!requirement) {
    return { ok: false, kind: "invalid", error: MIN_HOST_VERSION_FORMAT };
  }
  const currentVersion = normalizeOptionalString(params.currentVersion) || "unknown";
  const currentSemver = validSemver(currentVersion);
  if (!currentSemver) {
    return {
      ok: false,
      kind: "unknown_host_version",
      requirement,
    };
  }
  if (!satisfies(currentSemver, requirement.raw, { includePrerelease: true })) {
    return {
      ok: false,
      kind: "incompatible",
      requirement,
      currentVersion,
    };
  }
  return { ok: true, requirement };
}
