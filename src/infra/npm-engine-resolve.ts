/**
 * Engine-aware npm version resolution.
 *
 * Queries the npm registry for all versions of a package, then filters
 * to the latest version whose `engines.openclaw` constraint is satisfied
 * by the running OpenClaw core version.
 */
import { fetchPackageVersions, type NpmVersionEntry } from "./npm-registry-versions.js";
import { isPrerelease, satisfiesRange, sortVersionsDescending } from "./semver-range.js";

export type EngineResolveSuccess = {
  ok: true;
  version: string;
  engineRange?: string;
};

export type EngineResolveNoMatch = {
  ok: true;
  version: null;
  latestVersion?: string;
  latestRange?: string;
};

export type EngineResolveError = {
  ok: false;
  error: string;
};

export type EngineResolveResult = EngineResolveSuccess | EngineResolveNoMatch | EngineResolveError;

/**
 * Resolve the latest npm version of a package that is compatible with the given
 * OpenClaw core version, based on the `engines.openclaw` field in each version's
 * package.json.
 *
 * - Versions without `engines.openclaw` are assumed compatible.
 * - Prerelease versions are excluded unless `allowPrerelease` is true.
 * - Returns `{ ok: true, version: null }` when no compatible version exists.
 * - Returns `{ ok: false, error }` on network/registry errors.
 */
export async function resolveCompatibleVersion(params: {
  packageName: string;
  coreVersion: string;
  allowPrerelease?: boolean;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<EngineResolveResult> {
  const result = await fetchPackageVersions({
    packageName: params.packageName,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  if (result.versions.length === 0) {
    return { ok: true, version: null };
  }

  return resolveFromVersionEntries({
    versions: result.versions,
    coreVersion: params.coreVersion,
    allowPrerelease: params.allowPrerelease ?? false,
  });
}

/**
 * Pure resolution logic (no network). Useful for testing.
 */
export function resolveFromVersionEntries(params: {
  versions: NpmVersionEntry[];
  coreVersion: string;
  allowPrerelease: boolean;
}): EngineResolveSuccess | EngineResolveNoMatch {
  // Filter prereleases unless allowed
  const candidates = params.allowPrerelease
    ? params.versions
    : params.versions.filter((v) => !isPrerelease(v.version));

  if (candidates.length === 0) {
    return { ok: true, version: null };
  }

  // Sort versions descending
  const sortedVersions = sortVersionsDescending(candidates.map((v) => v.version));
  const versionMap = new Map<string, NpmVersionEntry>();
  for (const entry of candidates) {
    versionMap.set(entry.version, entry);
  }

  // Find the latest compatible version
  for (const version of sortedVersions) {
    const entry = versionMap.get(version);
    if (!entry) {
      continue;
    }

    const engineRange = entry.engines?.openclaw;
    if (!engineRange) {
      // No engine constraint → assumed compatible
      return { ok: true, version };
    }
    if (satisfiesRange(params.coreVersion, engineRange)) {
      return { ok: true, version, engineRange };
    }
  }

  // No compatible version found — report the latest version and its range for diagnostics
  const latestVersion = sortedVersions[0];
  const latestEntry = latestVersion ? versionMap.get(latestVersion) : undefined;
  return {
    ok: true,
    version: null,
    latestVersion,
    latestRange: latestEntry?.engines?.openclaw,
  };
}

/**
 * Format a user-facing error message when no compatible version is found.
 */
export function formatEngineIncompatibleError(params: {
  packageName: string;
  coreVersion: string;
  latestVersion?: string;
  latestRange?: string;
}): string {
  const parts = [
    `No version of ${params.packageName} is compatible with openclaw ${params.coreVersion}.`,
  ];
  if (params.latestVersion && params.latestRange) {
    parts.push(`Latest version ${params.latestVersion} requires openclaw ${params.latestRange}.`);
  }
  parts.push("Upgrade openclaw or use --ignore-engine to force install.");
  return parts.join(" ");
}
