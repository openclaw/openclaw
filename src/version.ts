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

export function resolveVersionFromModuleUrl(moduleUrl: string): string | null {
  return (
    readVersionFromPackageJsonForModuleUrl(moduleUrl) ||
    readVersionFromBuildInfoForModuleUrl(moduleUrl)
  );
}

export type RuntimeVersionEnv = {
  [key: string]: string | undefined;
};

export function resolveRuntimeServiceVersion(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
  fallback = "dev",
): string {
  return (
    firstNonEmpty(
      env["OPENCLAW_VERSION"],
      env["OPENCLAW_SERVICE_VERSION"],
      env["npm_package_version"],
    ) ?? fallback
  );
}

// Single source of truth for the current OpenClaw version.
// Priority (highest → lowest):
//   1. __OPENCLAW_VERSION__ — injected at build time via bundler define (always wins).
//   2. resolveVersionFromModuleUrl — reads package.json / build-info.json on disk;
//      present whenever the package is installed or run from source.
//   3. OPENCLAW_BUNDLED_VERSION — env-var fallback for containerised / stripped builds
//      where the on-disk metadata is absent.  Only consulted when neither of the above
//      is available so a stale env value cannot shadow the real installed version.
//   4. "0.0.0" — last-resort sentinel.
export const VERSION =
  (typeof __OPENCLAW_VERSION__ === "string" && __OPENCLAW_VERSION__) ||
  resolveVersionFromModuleUrl(import.meta.url) ||
  process.env.OPENCLAW_BUNDLED_VERSION ||
  "0.0.0";
