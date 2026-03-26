import { createRequire } from "node:module";

declare const __OPENCLAW_VERSION__: string | undefined;
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

type BuildInfoJson = {
  version?: string;
  displayVersionMarker?: string;
};

function readVersionFromJsonCandidates(
  moduleUrl: string,
  candidates: readonly string[],
  opts: { requirePackageName?: boolean } = {},
): string | null {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of candidates) {
      try {
        const parsed = require(candidate) as { name?: string; version?: string };
        const version = parsed.version?.trim();
        if (!version) {
          continue;
        }
        if (opts.requirePackageName && parsed.name !== CORE_PACKAGE_NAME) {
          continue;
        }
        return version;
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
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function readVersionFromPackageJsonForModuleUrl(moduleUrl: string): string | null {
  return readVersionFromJsonCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES, {
    requirePackageName: true,
  });
}

export function readVersionFromBuildInfoForModuleUrl(moduleUrl: string): string | null {
  return readVersionFromJsonCandidates(moduleUrl, BUILD_INFO_CANDIDATES);
}

export function readDisplayVersionMarkerFromBuildInfoForModuleUrl(
  moduleUrl: string,
): string | null {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of BUILD_INFO_CANDIDATES) {
      try {
        const parsed = require(candidate) as BuildInfoJson;
        const marker = parsed.displayVersionMarker?.trim();
        if (marker) {
          return marker;
        }
      } catch {
        // ignore missing or unreadable candidate
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveVersionFromModuleUrl(moduleUrl: string): string | null {
  return (
    readVersionFromPackageJsonForModuleUrl(moduleUrl) ||
    readVersionFromBuildInfoForModuleUrl(moduleUrl)
  );
}

export function formatDisplayVersion(version: string, marker?: string | null): string {
  const trimmedVersion = version.trim();
  const trimmedMarker = marker?.trim();
  if (!trimmedMarker) {
    return trimmedVersion;
  }
  return `${trimmedVersion} [${trimmedMarker}]`;
}

export function resolveBinaryVersion(params: {
  moduleUrl: string;
  injectedVersion?: string;
  bundledVersion?: string;
  fallback?: string;
}): string {
  return (
    firstNonEmpty(params.injectedVersion) ||
    resolveVersionFromModuleUrl(params.moduleUrl) ||
    firstNonEmpty(params.bundledVersion) ||
    params.fallback ||
    "0.0.0"
  );
}

export type RuntimeVersionEnv = {
  [key: string]: string | undefined;
};

export const RUNTIME_SERVICE_VERSION_FALLBACK = "unknown";

export function resolveUsableRuntimeVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim();
  // "0.0.0" is the resolver's hard fallback when module metadata cannot be read.
  // Prefer explicit service/package markers in that edge case.
  if (!trimmed || trimmed === "0.0.0") {
    return undefined;
  }
  return trimmed;
}

export function resolveRuntimeServiceVersion(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
  fallback = RUNTIME_SERVICE_VERSION_FALLBACK,
): string {
  const runtimeVersion = resolveUsableRuntimeVersion(VERSION);

  return (
    firstNonEmpty(
      env["OPENCLAW_VERSION"],
      runtimeVersion,
      env["OPENCLAW_SERVICE_VERSION"],
      env["npm_package_version"],
    ) ?? fallback
  );
}

// Single source of truth for the current OpenClaw version.
// - Embedded/bundled builds: injected define or env var.
// - Dev/npm builds: package.json.
export const VERSION = resolveBinaryVersion({
  moduleUrl: import.meta.url,
  injectedVersion: typeof __OPENCLAW_VERSION__ === "string" ? __OPENCLAW_VERSION__ : undefined,
  bundledVersion: process.env.OPENCLAW_BUNDLED_VERSION,
});

export const DISPLAY_VERSION = formatDisplayVersion(
  VERSION,
  process.env.OPENCLAW_DISPLAY_VERSION_MARKER ??
    readDisplayVersionMarkerFromBuildInfoForModuleUrl(import.meta.url),
);
