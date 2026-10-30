import { createRequire } from "node:module";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveLoadedCommitHash } from "./infra/git-commit.js";

const CORE_PACKAGE_NAME = "openclaw";

const PACKAGE_JSON_CANDIDATES = [
  "../package.json",
  "../../package.json",
  "../../../package.json",
  "./package.json",
] as const;

const BUILD_INFO_CANDIDATES = [
  "../build-info.json",
  "../../build-info.json",
  "./build-info.json",
] as const;

function readStringFromJsonCandidates(
  moduleUrl: string,
  candidates: readonly string[],
  field: "version",
  requirePackageName = false,
): string | null {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of candidates) {
      try {
        const parsed = require(candidate) as { name?: unknown; version?: unknown };
        const value = normalizeOptionalString(parsed[field]);
        if (!value) {
          continue;
        }
        if (requirePackageName && parsed.name !== CORE_PACKAGE_NAME) {
          continue;
        }
        return value;
      } catch {
        // ignore missing or unreadable candidate
      }
    }
    return null;
  } catch {
    return null;
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = normalizeOptionalString(value);
    if (trimmed && trimmed.toLowerCase() !== "undefined" && trimmed.toLowerCase() !== "null") {
      return trimmed;
    }
  }
  return undefined;
}

function readVersionFromPackageJsonForModuleUrl(moduleUrl: string): string | null {
  return readStringFromJsonCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES, "version", true);
}

function readVersionFromBuildInfoForModuleUrl(moduleUrl: string): string | null {
  return readStringFromJsonCandidates(moduleUrl, BUILD_INFO_CANDIDATES, "version");
}

export function readBuildIdFromBuildInfoForModuleUrl(moduleUrl: string): string | null {
  return readBuildProvenanceForModuleUrl(moduleUrl)?.buildId ?? null;
}

/**
 * The loaded build's record: its ID, the version, commit and build time recorded beside it (an
 * explicit UI build ID can replace the ID, never these), and the file when it resolves to one.
 */
export type BuildProvenance = {
  buildId: string;
  version?: string;
  commit?: string;
  builtAt?: string;
  buildInfoPath?: string;
};

export function readBuildProvenanceForModuleUrl(moduleUrl: string): BuildProvenance | null {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of BUILD_INFO_CANDIDATES) {
      try {
        // SAFETY: every field is read as unknown and normalized before use.
        const parsed = require(candidate) as Record<string, unknown>;
        const buildId = normalizeOptionalString(parsed.buildId);
        if (buildId && buildId.length <= 96) {
          const provenance: BuildProvenance = { buildId };
          for (const field of ["version", "commit", "builtAt"] as const) {
            const value = normalizeOptionalString(parsed[field]);
            if (value) {
              provenance[field] = value;
            }
          }
          try {
            provenance.buildInfoPath = require.resolve(candidate);
          } catch {
            // The ID stands on its own; only consumers that need the location lose it.
          }
          return provenance;
        }
      } catch {
        // ignore missing or unreadable candidate
      }
    }
  } catch {
    // Invalid module URL means no loaded build metadata is available.
  }
  return null;
}

export function resolveVersionFromModuleUrl(moduleUrl: string): string | null {
  // build-info.json records the version this artifact was built from, so it wins:
  // a git checkout whose source moved ahead of dist must not report the unbuilt
  // source version. Source runs have no build-info and fall back to package.json.
  return (
    readVersionFromBuildInfoForModuleUrl(moduleUrl) ||
    readVersionFromPackageJsonForModuleUrl(moduleUrl)
  );
}

export function resolveBinaryVersion(params: {
  moduleUrl: string;
  bundledVersion?: string;
}): string {
  return (
    resolveVersionFromModuleUrl(params.moduleUrl) || firstNonEmpty(params.bundledVersion) || "0.0.0"
  );
}

export type RuntimeVersionEnv = {
  [key: string]: string | undefined;
};

const RUNTIME_SERVICE_VERSION_FALLBACK = "unknown";
type RuntimeVersionPreference = "env-first" | "runtime-first";

export function resolveUsableRuntimeVersion(version: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(version);
  // "0.0.0" is the resolver's hard fallback when module metadata cannot be read.
  // Prefer explicit runtime/package markers in that edge case.
  if (!trimmed || trimmed === "0.0.0") {
    return undefined;
  }
  return trimmed;
}

function resolveVersionFromRuntimeSources(params: {
  env: RuntimeVersionEnv;
  runtimeVersion: string | undefined;
  fallback: string;
  preference: RuntimeVersionPreference;
}): string {
  const preferredCandidates =
    params.preference === "env-first"
      ? [params.env["OPENCLAW_VERSION"], params.runtimeVersion]
      : [params.runtimeVersion, params.env["OPENCLAW_VERSION"]];
  return (
    firstNonEmpty(...preferredCandidates, params.env["npm_package_version"]) ?? params.fallback
  );
}

export function resolveRuntimeServiceVersion(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
  fallback = RUNTIME_SERVICE_VERSION_FALLBACK,
): string {
  return resolveVersionFromRuntimeSources({
    env,
    runtimeVersion: resolveUsableRuntimeVersion(VERSION),
    fallback,
    preference: "env-first",
  });
}

// Loaded build provenance is immutable for a process. Resolve it once so a
// checkout update cannot change the identity reported by the running service.
const RUNTIME_SERVICE_BUILD = readBuildProvenanceForModuleUrl(import.meta.url);
const RUNTIME_SERVICE_COMMIT = resolveLoadedCommitHash({ moduleUrl: import.meta.url });

export function resolveRuntimeServiceBuildId(): string | null {
  return RUNTIME_SERVICE_BUILD?.buildId ?? null;
}

/** Build provenance captured when this process loaded, never re-read after a rebuild. */
export function resolveRuntimeServiceBuildProvenance(): BuildProvenance | null {
  return RUNTIME_SERVICE_BUILD;
}

export function resolveRuntimeServiceCommit(): string | null {
  return RUNTIME_SERVICE_COMMIT;
}

export function resolveCompatibilityHostVersion(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): string {
  const explicitCompatibilityVersion = firstNonEmpty(env.OPENCLAW_COMPATIBILITY_HOST_VERSION);
  if (explicitCompatibilityVersion) {
    return explicitCompatibilityVersion;
  }
  return resolveVersionFromRuntimeSources({
    env,
    runtimeVersion: resolveUsableRuntimeVersion(VERSION),
    fallback: RUNTIME_SERVICE_VERSION_FALLBACK,
    preference: env === (process.env as RuntimeVersionEnv) ? "runtime-first" : "env-first",
  });
}

// Single source of truth for the current OpenClaw version.
// - Embedded/bundled builds: bundled-version env var.
// - Dev/npm builds: package.json.
export const VERSION = resolveBinaryVersion({
  moduleUrl: import.meta.url,
  bundledVersion: process.env.OPENCLAW_BUNDLED_VERSION,
});
