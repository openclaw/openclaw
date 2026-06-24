// Detects installed plugin artifacts built against a different OpenClaw release than this host.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { compareComparableSemver, parseComparableSemver } from "../infra/semver-compare.js";

/** Build/host version pair for a plugin whose recorded build host does not match this host. */
export type PluginBuildVersionSkew = {
  buildVersion: string;
  currentVersion: string;
};

/**
 * Checks a plugin's recorded `openclaw.build.openclawVersion` against the running host.
 *
 * Stable-built plugins rely on additive SDK evolution, so older stable builds stay quiet.
 * Prerelease builds only match the exact host they were built for: prerelease SDK surface
 * can be withdrawn before the train ships (a beta-built plugin importing a barrel export
 * the stable release dropped fails as a call-time TypeError under the jiti loader).
 */
export function checkPluginBuildVersionSkew(params: {
  currentVersion: string | undefined;
  buildOpenclawVersion: unknown;
}): PluginBuildVersionSkew | null {
  const buildVersion = normalizeOptionalString(params.buildOpenclawVersion);
  const currentVersion = normalizeOptionalString(params.currentVersion);
  // Missing build metadata (dev/local/git installs) is not skew; only release artifacts carry it.
  if (!buildVersion || !currentVersion || buildVersion === currentVersion) {
    return null;
  }
  const buildSemver = parseComparableSemver(buildVersion);
  const currentSemver = parseComparableSemver(currentVersion);
  if (!buildSemver || !currentSemver) {
    return null;
  }
  const skew = { buildVersion, currentVersion };
  if (buildSemver.prerelease) {
    return skew;
  }
  // Stable builds are safe on hosts at or past their release; prerelease hosts of the same
  // triple order below the stable build, so this also catches hosts that predate it.
  const comparison = compareComparableSemver(currentSemver, buildSemver);
  return comparison !== null && comparison < 0 ? skew : null;
}
