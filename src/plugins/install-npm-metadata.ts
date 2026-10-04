import {
  loadNpmPackageVersions,
  resolveNpmSpecMetadata,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import {
  isPrereleaseSemverVersion,
  type ParsedRegistryNpmSpec,
} from "../infra/npm-registry-spec.js";
import { comparePackageUpdateVersions } from "../infra/package-update-utils.js";
import {
  validateOpenClawPackageInstallCompatibility,
  type PluginInstallRuntime,
} from "./install-shared.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type PluginInstallFailureResult,
  type PluginInstallLogger,
} from "./install-types.js";
import type { OpenClawPackageManifest } from "./manifest.js";

export function isNpmPackageNotFoundMessage(error: string): boolean {
  const normalized = error.trim();
  if (normalized.startsWith("Package not found on npm:")) {
    return true;
  }
  return /E404|404 not found|not in this registry/i.test(normalized);
}

export type TrustedOfficialPrereleaseResolution = {
  resolvedPrereleaseVersion: string;
  warning: string;
} & (
  | { kind: "stable"; resolution: NpmSpecResolution }
  | { kind: "prerelease-only"; resolution: NpmSpecResolution }
  | { kind: "allow-prerelease-only" }
);

export async function resolveTrustedOfficialPrereleaseResolution(params: {
  spec: ParsedRegistryNpmSpec;
  resolvedPrereleaseVersion: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  killProcessTree?: boolean;
}): Promise<TrustedOfficialPrereleaseResolution | null> {
  if (!params.spec.name.startsWith("@openclaw/")) {
    return null;
  }
  const semverVersions = await loadNpmPackageVersions({
    packageName: params.spec.name,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    killProcessTree: params.killProcessTree,
  });
  if (!semverVersions) {
    return null;
  }
  const stableVersion = semverVersions
    .filter((value) => !isPrereleaseSemverVersion(value))
    .toSorted(comparePackageUpdateVersions)
    .at(-1);
  let version = stableVersion;
  if (!stableVersion) {
    const prereleaseVersion = semverVersions
      .filter(isPrereleaseSemverVersion)
      .toSorted(comparePackageUpdateVersions)
      .at(-1);
    if (!prereleaseVersion || !semverVersions.every(isPrereleaseSemverVersion)) {
      return null;
    }
    if (prereleaseVersion === params.resolvedPrereleaseVersion) {
      return {
        kind: "allow-prerelease-only",
        resolvedPrereleaseVersion: params.resolvedPrereleaseVersion,
        warning: `Resolved ${params.spec.raw} to prerelease version ${params.resolvedPrereleaseVersion}; allowing it because this trusted official OpenClaw package has no stable npm versions yet.`,
      };
    }
    version = prereleaseVersion;
  }

  const spec = `${params.spec.name}@${version}`;
  const metadataResult = await resolveNpmSpecMetadata({
    spec,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  if (!metadataResult.ok) {
    return null;
  }
  return {
    kind: stableVersion ? "stable" : "prerelease-only",
    resolution: metadataResult.metadata,
    resolvedPrereleaseVersion: params.resolvedPrereleaseVersion,
    warning: stableVersion
      ? `Resolved ${params.spec.raw} to prerelease version ${params.resolvedPrereleaseVersion}; falling back to stable ${spec} for this trusted official OpenClaw install.`
      : `Resolved ${params.spec.raw} to prerelease version ${params.resolvedPrereleaseVersion}; using newest prerelease ${spec} because this trusted official OpenClaw package has no stable npm versions yet.`,
  };
}

function shouldResolveLatestCompatibleNpmVersion(spec: ParsedRegistryNpmSpec): boolean {
  return (
    spec.selectorKind === "none" ||
    (spec.selectorKind === "tag" && (spec.selector ?? "").toLowerCase() === "latest")
  );
}

function shouldResolveCompatiblePrereleaseNpmVersion(params: {
  spec: ParsedRegistryNpmSpec;
  currentVersion: string;
}): boolean {
  if (!isPrereleaseSemverVersion(params.currentVersion)) {
    return false;
  }
  if (params.spec.selectorKind === "none") {
    return true;
  }
  return (
    params.spec.selectorKind === "tag" && (params.spec.selector ?? "").toLowerCase() !== "latest"
  );
}

function resolvePrereleaseChannel(version: string): string | null {
  if (!isPrereleaseSemverVersion(version)) {
    return null;
  }
  const match = /^\s*v?\d+\.\d+\.\d+-([0-9A-Za-z]+)(?:[.-]|$)/.exec(version);
  return match?.[1]?.toLowerCase() ?? null;
}

export function canResolveAroundCompatibilityError(error: PluginInstallFailureResult): boolean {
  return (
    error.code === PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION ||
    error.code === PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API
  );
}

export function validateNpmResolutionCompatibility(params: {
  runtime: PluginInstallRuntime;
  parsedSpec: ParsedRegistryNpmSpec;
  expectedPluginId?: string;
  resolution: NpmSpecResolution;
}): PluginInstallFailureResult | null {
  return validateOpenClawPackageInstallCompatibility({
    runtime: params.runtime,
    pluginId: params.expectedPluginId ?? params.resolution.name ?? params.parsedSpec.name,
    packageMetadata: params.resolution.packageOpenClaw as OpenClawPackageManifest | undefined,
  });
}

export async function resolveLatestCompatibleNpmResolution(params: {
  runtime: PluginInstallRuntime;
  parsedSpec: ParsedRegistryNpmSpec;
  expectedPluginId?: string;
  currentResolution: NpmSpecResolution;
  timeoutMs: number;
  signal?: AbortSignal;
  logger: PluginInstallLogger;
}): Promise<NpmSpecResolution | null> {
  if (!params.currentResolution.version) {
    return null;
  }
  const currentVersion = params.currentResolution.version;
  const allowPrereleaseCandidates = shouldResolveCompatiblePrereleaseNpmVersion({
    spec: params.parsedSpec,
    currentVersion,
  });
  const prereleaseChannel = allowPrereleaseCandidates
    ? resolvePrereleaseChannel(currentVersion)
    : null;
  if (!shouldResolveLatestCompatibleNpmVersion(params.parsedSpec) && !allowPrereleaseCandidates) {
    return null;
  }

  const versions = await loadNpmPackageVersions({
    packageName: params.parsedSpec.name,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    killProcessTree: true,
  });
  if (!versions) {
    return null;
  }

  const candidates = versions
    .filter((version) =>
      allowPrereleaseCandidates
        ? resolvePrereleaseChannel(version) === prereleaseChannel
        : !isPrereleaseSemverVersion(version),
    )
    .filter((version) => comparePackageUpdateVersions(version, currentVersion) < 0)
    .toSorted(comparePackageUpdateVersions)
    .toReversed();
  for (const version of candidates) {
    const spec = `${params.parsedSpec.name}@${version}`;
    const metadataResult = await resolveNpmSpecMetadata({
      spec,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
    if (!metadataResult.ok) {
      params.logger.warn?.(
        `Could not inspect ${spec} while looking for a compatible plugin version: ${metadataResult.error}`,
      );
      continue;
    }
    const compatibilityError = validateNpmResolutionCompatibility({
      runtime: params.runtime,
      parsedSpec: params.parsedSpec,
      expectedPluginId: params.expectedPluginId,
      resolution: metadataResult.metadata,
    });
    if (!compatibilityError) {
      params.logger.warn?.(
        `Resolved ${params.parsedSpec.raw} to ${params.currentResolution.resolvedSpec ?? currentVersion}, but that version is incompatible with this OpenClaw runtime; using newest compatible ${metadataResult.metadata.resolvedSpec ?? spec}.`,
      );
      return metadataResult.metadata;
    }
  }

  return null;
}
