import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { prerelease as parseSemverPrerelease, satisfies as satisfiesSemver } from "semver";
import { PLUGIN_INSTALL_ERROR_CODE, type PluginInstallFailureResult } from "./install-types.js";
import { checkMinHostVersion } from "./min-host-version.js";

function normalizePartialComparableVersion(version: string): {
  version: string;
  isPartial: boolean;
} {
  const trimmed = version.trim();
  return /^[vV]?[0-9]+\.[0-9]+$/.test(trimmed)
    ? { version: `${trimmed}.0`, isPartial: true }
    : { version: trimmed, isPartial: false };
}

function normalizePluginApiVersionForComparator(version: string, target: string): string {
  const normalizedCorrection = OPENCLAW_NUMERIC_CORRECTION_PATTERN.exec(version.trim())?.[1];
  if (normalizedCorrection) {
    return normalizedCorrection;
  }
  return parseSemverPrerelease(normalizePartialComparableVersion(target).version)
    ? version
    : (OPENCLAW_RELEASE_SUFFIX_PATTERN.exec(version.trim())?.[1] ?? version);
}

function satisfiesComparator(version: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) {
    return true;
  }
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(trimmed);
  if (!match) {
    return false;
  }
  const operator = match[1] ?? "";
  const target = match[2]?.trim();
  if (!target || /^[<>=^~]/.test(target)) {
    return false;
  }
  const comparableVersion = normalizePluginApiVersionForComparator(version, target);
  const normalizedTarget = normalizePartialComparableVersion(target);
  const comparator =
    normalizedTarget.isPartial && !operator
      ? `>=${normalizedTarget.version}`
      : `${operator}${normalizedTarget.version}`;
  return satisfiesSemver(comparableVersion, comparator, { includePrerelease: true });
}

function satisfiesSemverRange(version: string, range: string): boolean {
  if (range.includes("||")) {
    return false;
  }
  const tokens = normalizeStringEntries(range.trim().split(/\s+/));
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => satisfiesComparator(version, token));
}

const OPENCLAW_RELEASE_SUFFIX_PATTERN =
  /^[vV]?(\d{4}\.[1-9]\d?\.[1-9]\d*)(?:-\d+|-(?:alpha|beta|rc)\.\d+)$/i;
const OPENCLAW_NUMERIC_CORRECTION_PATTERN = /^[vV]?(\d{4}\.[1-9]\d?\.[1-9]\d*)-\d+$/;

/** Result of reading package.json openclaw.compat.pluginApi metadata. */
type PackagePluginApiRangeResult = { ok: true; range?: string } | { ok: false; error: string };

/** Resolves the plugin API compatibility range declared by package metadata. */
export function resolvePackagePluginApiRange(
  packageMetadata: unknown,
): PackagePluginApiRangeResult {
  if (!isRecord(packageMetadata) || !("compat" in packageMetadata)) {
    return { ok: true };
  }
  const compat = packageMetadata.compat;
  if (compat === undefined || compat === null) {
    return { ok: true };
  }
  if (!isRecord(compat)) {
    return { ok: false, error: "package.json openclaw.compat must be an object" };
  }
  if (!("pluginApi" in compat)) {
    return { ok: true };
  }
  const pluginApi = compat.pluginApi;
  if (typeof pluginApi !== "string") {
    return { ok: false, error: "package.json openclaw.compat.pluginApi must be a string" };
  }
  const range = pluginApi.trim();
  if (!range) {
    return { ok: false, error: "package.json openclaw.compat.pluginApi must not be empty" };
  }
  return { ok: true, range };
}

/** Checks whether a host plugin API version satisfies a package plugin API range. */
export function satisfiesPluginApiRange(
  pluginApiVersion: string,
  pluginApiRange?: string | null,
): boolean {
  if (!pluginApiRange) {
    return true;
  }
  return satisfiesSemverRange(pluginApiVersion, pluginApiRange);
}

export function validateOpenClawPackageInstallCompatibility(params: {
  currentHostVersion: string;
  pluginId: string;
  packageMetadata?: unknown;
  allowLegacyBareSemver?: boolean;
}): PluginInstallFailureResult | null {
  const { currentHostVersion } = params;
  const installMetadata = isRecord(params.packageMetadata)
    ? params.packageMetadata.install
    : undefined;
  const minHostVersionCheck = checkMinHostVersion({
    currentVersion: currentHostVersion,
    minHostVersion: isRecord(installMetadata) ? installMetadata.minHostVersion : undefined,
    allowLegacyBareSemver: params.allowLegacyBareSemver,
  });
  if (!minHostVersionCheck.ok) {
    if (minHostVersionCheck.kind === "invalid") {
      return {
        ok: false,
        error: `invalid package.json openclaw.install.minHostVersion: ${minHostVersionCheck.error}`,
        code: PLUGIN_INSTALL_ERROR_CODE.INVALID_MIN_HOST_VERSION,
      };
    }
    if (minHostVersionCheck.kind === "unknown_host_version") {
      return {
        ok: false,
        error: `plugin "${params.pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined. Re-run from a released build or set OPENCLAW_VERSION and retry.`,
        code: PLUGIN_INSTALL_ERROR_CODE.UNKNOWN_HOST_VERSION,
      };
    }
    return {
      ok: false,
      error: `plugin "${params.pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}. Upgrade OpenClaw and retry.`,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION,
    };
  }

  const pluginApiRangeCheck = resolvePackagePluginApiRange(params.packageMetadata);
  if (!pluginApiRangeCheck.ok) {
    return {
      ok: false,
      error: `invalid package.json openclaw.compat.pluginApi: ${pluginApiRangeCheck.error}`,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_PLUGIN_API,
    };
  }
  const pluginApiRange = pluginApiRangeCheck.range;
  if (pluginApiRange && !satisfiesPluginApiRange(currentHostVersion, pluginApiRange)) {
    return {
      ok: false,
      error: `plugin "${params.pluginId}" requires plugin API ${pluginApiRange}, but this OpenClaw runtime exposes ${currentHostVersion}. Upgrade OpenClaw or install a compatible plugin version and retry.`,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
    };
  }
  return null;
}
