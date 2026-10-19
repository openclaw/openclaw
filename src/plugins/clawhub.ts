import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  type ArchiveEntryKind,
} from "../infra/archive.js";
import { downloadClawHubPackageArchive } from "../infra/clawhub-artifacts.js";
import {
  ClawHubRequestError,
  isDefaultClawHubBaseUrl,
  resolveClawHubBaseUrl,
} from "../infra/clawhub-client.js";
import { checkClawHubPackageTrust } from "../infra/clawhub-install-trust.js";
import {
  normalizeClawHubSha256Integrity,
  normalizeClawHubSha256Hex,
} from "../infra/clawhub-integrity.js";
import {
  fetchClawHubPackageArtifact,
  fetchClawHubPackageDetail,
  fetchClawHubPackageVersion,
  resolveLatestVersionFromPackage,
  type ClawHubPackageArtifactSummary,
  type ClawHubPackageArtifactResolverResponse,
  type ClawHubPackageCompatibility,
  type ClawHubPackageDetail,
  type ClawHubPackageClawPackSummary,
  type ClawHubResolvedArtifact,
} from "../infra/clawhub-packages.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ExtractedArchiveVerification } from "../infra/install-flow.js";
import type { TimedInstallModeOptions } from "../infra/install-mode-options.js";
import { withInstallActivity } from "../infra/install-progress.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import type { RuntimeVersionEnv } from "../version.js";
import {
  CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE,
  mapClawHubArchiveReadFailure,
  verifyClawHubExtractedFiles,
  type ClawHubFileVerificationEntry,
} from "./clawhub-archive-verification.js";
import {
  buildClawHubInstallFailure,
  CLAWHUB_INSTALL_ERROR_CODE,
  type ClawHubInstallFailure,
} from "./clawhub-error-codes.js";
import {
  normalizeClawHubClawPackInstallFields,
  type ClawHubPluginInstallRecordFields,
} from "./clawhub-install-records.js";
import { isDefaultOfficialClawHubPackage } from "./clawhub-official-source.js";
import {
  formatClawHubReleaseLabel,
  formatClawHubSpecifier,
  logClawHubPackageSummary,
  type PluginInstallLogger,
} from "./clawhub-presentation.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { copyPluginInstallTransactionRequest } from "./install-transaction.js";
import type { PluginInstallArtifactCallbacks } from "./install-types.js";
import {
  installPluginFromArchive,
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
} from "./install.js";
import { checkMinHostVersion } from "./min-host-version.js";
import { satisfiesPluginApiRange } from "./package-compat.js";

export { CLAWHUB_INSTALL_ERROR_CODE };

type ClawHubRuntimeIdResolution =
  | { ok: true; expectedPluginId?: string }
  | Extract<InstallPluginResult, { ok: false }>;

type ClawHubFileEntryLike = {
  path?: unknown;
  sha256?: unknown;
};

type ClawHubArchiveVerification =
  | {
      kind: "archive-integrity";
      integrity: string;
    }
  | {
      kind: "file-list";
      files: ClawHubFileVerificationEntry[];
    };

type ClawHubArchiveVerificationResolution =
  | {
      ok: true;
      verification: ClawHubArchiveVerification | null;
    }
  | ClawHubInstallFailure;

type ClawHubArtifactResolverVersion = NonNullable<
  Exclude<ClawHubPackageArtifactResolverResponse["version"], string | null | undefined>
>;

type ClawHubInstallArtifactDecision = {
  version: string;
  compatibility?: ClawHubPackageCompatibility | null;
  verification: ClawHubArchiveVerification | null;
  clawpack?: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null;
};

const CLAWHUB_ARCHIVE_LIMITS = {
  maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxExtractedBytes: DEFAULT_MAX_EXTRACTED_BYTES,
  maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
};

function resolveClawHubClawPackArtifactSha256(
  clawpack: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null | undefined,
): string | null {
  const isNpmPackArtifact =
    clawpack && "kind" in clawpack && normalizeOptionalString(clawpack.kind) === "npm-pack";
  const isLegacyClawPack = clawpack && "available" in clawpack && clawpack.available;
  if ((!isNpmPackArtifact && !isLegacyClawPack) || typeof clawpack.sha256 !== "string") {
    return null;
  }
  return normalizeClawHubSha256Hex(clawpack.sha256);
}

function resolveClawHubNpmPackArtifact(
  version: Pick<ClawHubArtifactResolverVersion, "artifact" | "clawpack">,
): ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null {
  if (version.artifact?.kind === "npm-pack") {
    return version.artifact;
  }
  if (version.clawpack?.available === true) {
    return version.clawpack;
  }
  return null;
}

function readArtifactResolverVersion(
  response: ClawHubPackageArtifactResolverResponse,
  requestedVersion: string,
): ClawHubArtifactResolverVersion {
  if (
    response.version &&
    typeof response.version === "object" &&
    !Array.isArray(response.version)
  ) {
    return response.version;
  }
  if (typeof response.version === "string" && response.version.trim().length > 0) {
    return { version: response.version.trim() };
  }
  return { version: requestedVersion };
}

type ClawHubResolvedArtifactWire = {
  artifactKind?: string | null;
  kind?: string | null;
  artifactSha256?: string | null;
  sha256?: string | null;
  npmIntegrity?: string | null;
  npmShasum?: string | null;
  size?: number | null;
  downloadUrl?: string | null;
};

function resolveTopLevelNpmPackArtifact(
  artifact: ClawHubResolvedArtifact | null | undefined,
): ClawHubPackageArtifactSummary | null {
  const wire = artifact as ClawHubResolvedArtifactWire | null | undefined;
  const artifactKind = wire?.artifactKind ?? wire?.kind;
  if (artifactKind !== "npm-pack") {
    return null;
  }
  if (typeof wire?.npmIntegrity !== "string") {
    return null;
  }
  return {
    kind: "npm-pack",
    format: "tgz",
    sha256: wire.artifactSha256 ?? wire.sha256 ?? null,
    npmIntegrity: wire.npmIntegrity,
    npmShasum: wire.npmShasum ?? null,
    size: wire.size ?? null,
    downloadUrl: wire.downloadUrl ?? null,
  };
}

function resolveTopLevelLegacyArchiveVerification(
  artifact: ClawHubResolvedArtifact | null | undefined,
): ClawHubArchiveVerification | null {
  const wire = artifact as ClawHubResolvedArtifactWire | null | undefined;
  const artifactKind = wire?.artifactKind ?? wire?.kind;
  const artifactSha256 = wire?.artifactSha256 ?? wire?.sha256;
  if (artifactKind !== "legacy-zip" || typeof artifactSha256 !== "string") {
    return null;
  }
  const integrity = normalizeClawHubSha256Integrity(artifactSha256);
  return integrity ? { kind: "archive-integrity", integrity } : null;
}

function mapClawHubRequestError(
  error: unknown,
  context: { stage: "package" | "version"; name: string; version?: string },
): ClawHubInstallFailure {
  if (error instanceof ClawHubRequestError && error.status === 404) {
    if (context.stage === "package") {
      return buildClawHubInstallFailure(
        "Package not found on ClawHub.",
        CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND,
      );
    }
    return buildClawHubInstallFailure(
      `Version not found on ClawHub: ${context.name}@${context.version ?? "unknown"}.`,
      CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND,
    );
  }
  return buildClawHubInstallFailure(formatErrorMessage(error));
}

function resolveClawHubExpectedRuntimeId(params: {
  detail: ClawHubPackageDetail;
  expectedPluginId?: string;
}): ClawHubRuntimeIdResolution {
  const packageRuntimeId = normalizeOptionalString(params.detail.package?.runtimeId);
  const capabilitiesRuntimeId = normalizeOptionalString(
    params.detail.package?.capabilities?.runtimeId,
  );
  if (packageRuntimeId && capabilitiesRuntimeId && packageRuntimeId !== capabilitiesRuntimeId) {
    return {
      ok: false,
      error: `ClawHub package runtime id mismatch: package advertises "${sanitizeTerminalText(packageRuntimeId)}" but capabilities advertise "${sanitizeTerminalText(capabilitiesRuntimeId)}".`,
      code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH,
    };
  }

  const advertisedRuntimeId = packageRuntimeId ?? capabilitiesRuntimeId;
  const expectedPluginId = normalizeOptionalString(params.expectedPluginId);
  if (expectedPluginId && advertisedRuntimeId && expectedPluginId !== advertisedRuntimeId) {
    return {
      ok: false,
      error: `ClawHub package runtime id mismatch: expected "${sanitizeTerminalText(expectedPluginId)}", got "${sanitizeTerminalText(advertisedRuntimeId)}".`,
      code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH,
    };
  }
  const resolvedExpectedPluginId = expectedPluginId ?? advertisedRuntimeId;
  return {
    ok: true,
    ...(resolvedExpectedPluginId ? { expectedPluginId: resolvedExpectedPluginId } : {}),
  };
}

function isMissingArtifactResolverRoute(error: unknown): boolean {
  return (
    error instanceof ClawHubRequestError &&
    error.status === 404 &&
    error.requestPath.endsWith("/artifact")
  );
}

function formatClawHubClawPackDownloadError(params: {
  error: unknown;
  packageName: string;
  version: string;
}): string {
  const message = formatErrorMessage(params.error);
  if (!(params.error instanceof ClawHubRequestError)) {
    return message;
  }
  return `ClawHub artifact download for "${params.packageName}@${params.version}" is not available yet (${message}). Use "npm:${params.packageName}@${params.version}" for launch installs while ClawHub artifact routing is being rolled out.`;
}

function isClawHubArtifactDownloadPolicyBlock(error: unknown): boolean {
  if (!(error instanceof ClawHubRequestError)) {
    return false;
  }
  const body = normalizeLowercaseStringOrEmpty(error.responseBody);
  return (
    body.includes("blocked from download") ||
    body.includes("download disabled") ||
    body.includes("disabled download") ||
    body.includes("cannot be downloaded") ||
    body.includes("malicious") ||
    body.includes("quarantine") ||
    body.includes("revoked")
  );
}

function formatClawHubArtifactDownloadPolicyBlock(params: {
  error: unknown;
  packageName: string;
  version: string;
}): string {
  return `ClawHub blocked artifact download for "${params.packageName}@${params.version}"; install was not started. ${formatErrorMessage(params.error)}`;
}

function formatClawHubMissingArtifactMetadataError(params: {
  packageName: string;
  version: string;
}): string {
  return `ClawHub package "${params.packageName}@${params.version}" does not expose a downloadable plugin artifact yet. Use "npm:${params.packageName}@${params.version}" for launch installs while ClawHub artifact routing is being rolled out.`;
}

function resolveRequestedVersion(params: {
  detail: ClawHubPackageDetail;
  requestedVersion?: string;
}): string | null {
  if (params.requestedVersion) {
    return params.detail.package?.tags?.[params.requestedVersion] ?? params.requestedVersion;
  }
  return resolveLatestVersionFromPackage(params.detail);
}

function validateClawHubRelativePath(value: unknown): { path: string } | { error: string } {
  if (typeof value !== "string") {
    return { error: `non-string value of type ${typeof value}` };
  }
  if (value.length === 0) {
    return { error: "empty string" };
  }
  if (value.trim() !== value) {
    return { error: `path "${value}" has leading or trailing whitespace` };
  }
  if (value.includes("\\")) {
    return { error: `path "${value}" contains backslashes` };
  }
  if (value.startsWith("/")) {
    return { error: `path "${value}" is absolute` };
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return { error: `path "${value}" contains an empty segment` };
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { error: `path "${value}" contains dot segments` };
  }
  return { path: value };
}

function describeInvalidClawHubSha256(value: unknown): string {
  if (typeof value !== "string") {
    return `non-string value of type ${typeof value}`;
  }
  if (value.length === 0) {
    return "empty string";
  }
  if (value.trim().length === 0) {
    return "whitespace-only string";
  }
  return `value "${value}" is not a 64-character hexadecimal SHA-256 digest`;
}

function resolveClawHubArchiveVerification(
  metadata: Pick<ClawHubArtifactResolverVersion, "sha256hash" | "files">,
  packageName: string,
  version: string,
): ClawHubArchiveVerificationResolution {
  const sha256hashValue = metadata.sha256hash;
  const sha256hash = normalizeOptionalString(sha256hashValue);
  const integrity = sha256hash ? normalizeClawHubSha256Integrity(sha256hash) : null;
  if (integrity) {
    return {
      ok: true,
      verification: {
        kind: "archive-integrity",
        integrity,
      },
    };
  }
  if (sha256hashValue !== undefined && sha256hashValue !== null) {
    const detail =
      typeof sha256hashValue === "string" && sha256hashValue.trim().length === 0
        ? "empty string"
        : typeof sha256hashValue === "string"
          ? `unrecognized value "${sha256hashValue.trim()}"`
          : `non-string value of type ${typeof sha256hashValue}`;
    return buildClawHubInstallFailure(
      `ClawHub version metadata for "${packageName}@${version}" has an invalid sha256hash (${detail}).`,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
    );
  }
  const files = metadata.files;
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: true,
      verification: null,
    };
  }
  const normalizedFiles: ClawHubFileVerificationEntry[] = [];
  const seenPaths = new Set<string>();
  for (const [index, file] of files.entries()) {
    if (!file || typeof file !== "object") {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" has an invalid files[${index}] entry (expected an object, got ${file === null ? "null" : typeof file}).`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    const fileRecord = file as ClawHubFileEntryLike;
    const validatedPath = validateClawHubRelativePath(fileRecord.path);
    const sha256Value = normalizeOptionalString(fileRecord.sha256);
    const sha256 = sha256Value ? normalizeClawHubSha256Hex(sha256Value) : null;
    if ("error" in validatedPath) {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" has an invalid files[${index}].path (${validatedPath.error}).`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    const filePath = validatedPath.path;
    if (filePath === CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE) {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" must not include generated file "${filePath}" in files[].`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    if (!sha256) {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" has an invalid files[${index}].sha256 (${describeInvalidClawHubSha256(fileRecord.sha256)}).`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    if (seenPaths.has(filePath)) {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" has duplicate files[] path "${filePath}".`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    seenPaths.add(filePath);
    normalizedFiles.push({ path: filePath, sha256 });
  }
  return {
    ok: true,
    verification: {
      kind: "file-list",
      files: normalizedFiles,
    },
  };
}

async function resolveCompatiblePackageVersion(params: {
  detail: ClawHubPackageDetail;
  requestedVersion?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}): Promise<({ ok: true } & ClawHubInstallArtifactDecision) | ClawHubInstallFailure> {
  const requestedVersion = resolveRequestedVersion(params);
  if (!requestedVersion) {
    return buildClawHubInstallFailure(
      `ClawHub package "${params.detail.package?.name ?? "unknown"}" has no installable version.`,
      CLAWHUB_INSTALL_ERROR_CODE.NO_INSTALLABLE_VERSION,
    );
  }
  let artifactResponse: ClawHubPackageArtifactResolverResponse;
  try {
    artifactResponse = await fetchClawHubPackageArtifact({
      name: params.detail.package?.name ?? "",
      version: requestedVersion,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    if (isMissingArtifactResolverRoute(error)) {
      try {
        const versionDetail = await fetchClawHubPackageVersion({
          name: params.detail.package?.name ?? "",
          version: requestedVersion,
          baseUrl: params.baseUrl,
          token: params.token,
          timeoutMs: params.timeoutMs,
        });
        artifactResponse = { version: versionDetail.version };
      } catch (versionError) {
        return mapClawHubRequestError(versionError, {
          stage: "version",
          name: params.detail.package?.name ?? "unknown",
          version: requestedVersion,
        });
      }
    } else {
      return mapClawHubRequestError(error, {
        stage: "version",
        name: params.detail.package?.name ?? "unknown",
        version: requestedVersion,
      });
    }
  }
  const artifactVersion = readArtifactResolverVersion(artifactResponse, requestedVersion);
  const resolvedVersion = normalizeOptionalString(artifactVersion.version) ?? requestedVersion;
  const latestVersion = resolveLatestVersionFromPackage(params.detail);
  // Only fall back to package-level compatibility when the resolved version is the
  // package latest. Older pinned versions should not inherit the latest version's
  // compatibility requirements.
  const packageCompatibilityFallback =
    resolvedVersion === latestVersion ? (params.detail.package?.compatibility ?? null) : null;
  // When the artifact endpoint returns sparse metadata (no compatibility) for a
  // pinned older version, fetch the version endpoint which may have the real
  // version-specific compatibility data.
  let versionEndpointCompatibility: ClawHubPackageCompatibility | null = null;
  if (!artifactVersion.compatibility && resolvedVersion !== latestVersion) {
    try {
      const selectedVersion = await fetchClawHubPackageVersion({
        name: params.detail.package?.name ?? "",
        version: resolvedVersion,
        baseUrl: params.baseUrl,
        token: params.token,
        timeoutMs: params.timeoutMs,
      });
      versionEndpointCompatibility = selectedVersion.version?.compatibility ?? null;
    } catch (error) {
      return mapClawHubRequestError(error, {
        stage: "version",
        name: params.detail.package?.name ?? "unknown",
        version: resolvedVersion,
      });
    }
  }
  const compatibility =
    artifactVersion.compatibility ?? versionEndpointCompatibility ?? packageCompatibilityFallback;
  if (params.detail.package?.family === "skill") {
    return {
      ok: true,
      version: resolvedVersion,
      compatibility,
      verification: null,
      clawpack:
        artifactVersion.clawpack ?? resolveTopLevelNpmPackArtifact(artifactResponse.artifact),
    };
  }
  const clawpack =
    resolveClawHubNpmPackArtifact(artifactVersion) ??
    resolveTopLevelNpmPackArtifact(artifactResponse.artifact);
  const verificationState = resolveClawHubArchiveVerification(
    artifactVersion,
    params.detail.package?.name ?? "unknown",
    resolvedVersion,
  );
  if (!verificationState.ok && !resolveClawHubClawPackArtifactSha256(clawpack)) {
    return verificationState;
  }
  return {
    ok: true,
    version: resolvedVersion,
    compatibility,
    verification: verificationState.ok
      ? (verificationState.verification ??
        resolveTopLevelLegacyArchiveVerification(artifactResponse.artifact))
      : null,
    clawpack,
  };
}

function validateClawHubPluginPackage(params: {
  detail: ClawHubPackageDetail;
  compatibility?: ClawHubPackageCompatibility | null;
  runtimeVersion: string;
}):
  | { ok: true; family: ClawHubPluginInstallRecordFields["clawhubFamily"] }
  | ClawHubInstallFailure {
  const pkg = params.detail.package;
  if (!pkg) {
    return buildClawHubInstallFailure(
      "Package not found on ClawHub.",
      CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND,
    );
  }
  if (pkg.family === "skill") {
    const installRef = pkg.ownerHandle ? `@${pkg.ownerHandle}/${pkg.name}` : pkg.name;
    return buildClawHubInstallFailure(
      `"${pkg.name}" is a skill. Use "openclaw skills install ${installRef}" instead.`,
      CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
    );
  }
  if (pkg.family !== "code-plugin" && pkg.family !== "bundle-plugin") {
    return buildClawHubInstallFailure(
      `Unsupported ClawHub package family: ${pkg.family}`,
      CLAWHUB_INSTALL_ERROR_CODE.UNSUPPORTED_FAMILY,
    );
  }
  if (pkg.channel === "private") {
    return buildClawHubInstallFailure(
      `"${pkg.name}" is private on ClawHub and cannot be installed anonymously.`,
      CLAWHUB_INSTALL_ERROR_CODE.PRIVATE_PACKAGE,
    );
  }

  const compatibility = params.compatibility;
  const runtimeVersion = params.runtimeVersion;
  if (
    compatibility?.pluginApiRange &&
    !satisfiesPluginApiRange(runtimeVersion, compatibility.pluginApiRange)
  ) {
    return buildClawHubInstallFailure(
      `Plugin "${pkg.name}" requires plugin API ${compatibility.pluginApiRange}, but this OpenClaw runtime exposes ${runtimeVersion}. Upgrade OpenClaw or choose an explicit compatible plugin version.`,
      CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
    );
  }

  const minGatewayVersion = compatibility?.minGatewayVersion;
  if (minGatewayVersion) {
    const minGatewayVersionCheck = checkMinHostVersion({
      currentVersion: runtimeVersion,
      minHostVersion: minGatewayVersion,
      allowLegacyBareSemver: true,
    });
    if (minGatewayVersionCheck.ok) {
      return { ok: true, family: pkg.family };
    }
    if (minGatewayVersionCheck.kind === "invalid") {
      return buildClawHubInstallFailure(
        `ClawHub package "${pkg.name}" declares invalid minGatewayVersion metadata "${sanitizeTerminalText(minGatewayVersion)}"; report the package metadata to its publisher.`,
        CLAWHUB_INSTALL_ERROR_CODE.INVALID_GATEWAY_VERSION,
      );
    }
    if (minGatewayVersionCheck.kind === "unknown_host_version") {
      return buildClawHubInstallFailure(
        `Plugin "${pkg.name}" requires OpenClaw >=${minGatewayVersionCheck.requirement.minimumLabel}, but this host version could not be determined. Re-run from a released build or set OPENCLAW_VERSION and retry.`,
        CLAWHUB_INSTALL_ERROR_CODE.UNKNOWN_GATEWAY_VERSION,
      );
    }
    return buildClawHubInstallFailure(
      `Plugin "${pkg.name}" requires OpenClaw >=${minGatewayVersionCheck.requirement.minimumLabel}, but this host is ${minGatewayVersionCheck.currentVersion}. Upgrade OpenClaw or choose an explicit compatible plugin version.`,
      CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_GATEWAY,
    );
  }
  return { ok: true, family: pkg.family };
}

export async function installPluginFromClawHub(
  params: InstallSafetyOverrides &
    TimedInstallModeOptions<PluginInstallLogger> &
    PluginInstallArtifactCallbacks & {
      spec: string;
      baseUrl?: string;
      token?: string;
      extensionsDir?: string;
      expectedPluginId?: string;
      expectedIntegrity?: string;
      env?: RuntimeVersionEnv;
      confirmOnUpdate?: boolean;
      confirmInstall?: (warning?: string) => boolean | Promise<boolean>;
      requireClawHubTrust?: boolean;
    },
): Promise<
  | ({
      ok: true;
    } & Extract<InstallPluginResult, { ok: true }> & {
        clawhub: ClawHubPluginInstallRecordFields;
        packageName: string;
        warning?: string;
      })
  | ClawHubInstallFailure
  | Extract<InstallPluginResult, { ok: false }>
> {
  const parsed = parseClawHubPluginSpec(params.spec);
  if (!parsed?.name) {
    return buildClawHubInstallFailure(
      `invalid ClawHub plugin spec: ${params.spec}`,
      CLAWHUB_INSTALL_ERROR_CODE.INVALID_SPEC,
    );
  }
  const expectedIntegrity =
    params.expectedIntegrity === undefined
      ? undefined
      : normalizeClawHubSha256Integrity(params.expectedIntegrity);
  if (params.expectedIntegrity !== undefined && !expectedIntegrity) {
    return buildClawHubInstallFailure(
      `invalid expected ClawHub archive integrity: ${sanitizeTerminalText(params.expectedIntegrity)}`,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
    );
  }

  params.logger?.info?.(`Resolving ${formatClawHubSpecifier(parsed)}…`);
  const resolved = await withInstallActivity(params.logger, "resolve", async () => {
    let detail: ClawHubPackageDetail;
    try {
      detail = await fetchClawHubPackageDetail({
        name: parsed.name,
        baseUrl: params.baseUrl,
        token: params.token,
        timeoutMs: params.timeoutMs,
      });
    } catch (error) {
      return mapClawHubRequestError(error, {
        stage: "package",
        name: parsed.name,
      });
    }
    const versionState = await resolveCompatiblePackageVersion({
      detail,
      requestedVersion: parsed.version,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
    if (!versionState.ok) {
      return versionState;
    }
    const runtimeVersion = resolveCompatibilityHostVersion(params.env);
    const validation = validateClawHubPluginPackage({
      detail,
      compatibility: versionState.compatibility,
      runtimeVersion,
    });
    if (!validation.ok) {
      return validation;
    }
    const runtimeIdResolution = resolveClawHubExpectedRuntimeId({
      detail,
      expectedPluginId: params.expectedPluginId,
    });
    if (!runtimeIdResolution.ok) {
      return runtimeIdResolution;
    }
    return {
      ok: true as const,
      detail,
      versionState,
      runtimeIdResolution,
      clawhubFamily: validation.family,
    };
  });
  if (!resolved.ok) {
    return resolved;
  }
  const { detail, versionState, runtimeIdResolution, clawhubFamily } = resolved;
  const expectedClawPackSha256 = resolveClawHubClawPackArtifactSha256(versionState.clawpack);
  const canonicalPackageName = detail.package?.name ?? parsed.name;
  const officialClawHubPackage = detail.package
    ? isDefaultOfficialClawHubPackage({ baseUrl: params.baseUrl, pkg: detail.package })
    : false;
  logClawHubPackageSummary({
    detail,
    version: versionState.version,
    compatibility: versionState.compatibility,
    baseUrl: params.baseUrl,
    logger: params.logger,
  });
  const trustResult =
    officialClawHubPackage && !params.requireClawHubTrust
      ? null
      : await checkClawHubPackageTrust({
          subject: { kind: "plugin", packageName: canonicalPackageName },
          version: versionState.version,
          baseUrl: params.baseUrl,
          token: params.token,
          timeoutMs: params.timeoutMs,
          logger: params.logger,
          mode: params.mode,
        });
  if (trustResult && !trustResult.ok) {
    return trustResult;
  }
  if (
    (params.mode !== "update" || params.confirmOnUpdate) &&
    params.confirmInstall &&
    !(await params.confirmInstall(trustResult?.warning))
  ) {
    return buildClawHubInstallFailure("Install cancelled.");
  }
  if (!versionState.verification && !expectedClawPackSha256) {
    return buildClawHubInstallFailure(
      formatClawHubMissingArtifactMetadataError({
        packageName: canonicalPackageName,
        version: versionState.version,
      }),
      CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE,
    );
  }
  const releaseLabel = formatClawHubReleaseLabel(canonicalPackageName, versionState.version);

  let archive;
  params.logger?.info?.(
    `Downloading ${detail.package?.family === "bundle-plugin" ? "bundle" : "plugin"} ${releaseLabel} from ClawHub…`,
  );
  try {
    archive = await withInstallActivity(params.logger, "download", () =>
      downloadClawHubPackageArchive({
        name: canonicalPackageName,
        version: versionState.version,
        artifact: expectedClawPackSha256 ? "clawpack" : "archive",
        baseUrl: params.baseUrl,
        token: params.token,
        timeoutMs: params.timeoutMs,
      }),
    );
  } catch (error) {
    if (isClawHubArtifactDownloadPolicyBlock(error)) {
      return buildClawHubInstallFailure(
        formatClawHubArtifactDownloadPolicyBlock({
          error,
          packageName: canonicalPackageName,
          version: versionState.version,
        }),
        CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED,
        undefined,
        versionState.version,
      );
    }
    // Fix-me(clawhub): remove this npm hint once ClawHub ClawPack artifact
    // routing is live for official package installs.
    return buildClawHubInstallFailure(
      expectedClawPackSha256
        ? formatClawHubClawPackDownloadError({
            error,
            packageName: canonicalPackageName,
            version: versionState.version,
          })
        : formatErrorMessage(error),
      expectedClawPackSha256 &&
        error instanceof ClawHubRequestError &&
        error.status === 404 &&
        error.requestPath.endsWith("/artifact/download")
        ? CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE
        : error instanceof ClawHubRequestError
          ? CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE
          : undefined,
    );
  }
  try {
    let verification: ExtractedArchiveVerification<ClawHubInstallFailure> | undefined;
    if (expectedIntegrity && archive.integrity !== expectedIntegrity) {
      return buildClawHubInstallFailure(
        `ClawHub archive integrity mismatch for "${releaseLabel}": expected ${expectedIntegrity}, got ${archive.integrity}.`,
        CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      );
    }
    if (expectedClawPackSha256) {
      const expectedClawPackIntegrity = normalizeClawHubSha256Integrity(expectedClawPackSha256);
      const expectedNpmIntegrity = normalizeOptionalString(versionState.clawpack?.npmIntegrity);
      if (
        archive.artifact !== "clawpack" ||
        archive.clawpackHeaderSha256 !== expectedClawPackSha256 ||
        archive.sha256Hex !== expectedClawPackSha256 ||
        archive.integrity !== expectedClawPackIntegrity
      ) {
        return buildClawHubInstallFailure(
          `ClawHub ClawPack integrity mismatch for "${releaseLabel}": expected ${expectedClawPackSha256}, got ${archive.sha256Hex}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      if (expectedNpmIntegrity && archive.npmIntegrity !== expectedNpmIntegrity) {
        return buildClawHubInstallFailure(
          `ClawHub ClawPack npm integrity mismatch for "${releaseLabel}": expected ${expectedNpmIntegrity}, got ${archive.npmIntegrity ?? "unknown"}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      const expectedNpmShasum = normalizeOptionalString(versionState.clawpack?.npmShasum);
      if (expectedNpmShasum && archive.npmShasum !== expectedNpmShasum) {
        return buildClawHubInstallFailure(
          `ClawHub ClawPack npm shasum mismatch for "${releaseLabel}": expected ${expectedNpmShasum}, got ${archive.npmShasum ?? "unknown"}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
    } else if (versionState.verification?.kind === "archive-integrity") {
      if (archive.integrity !== versionState.verification.integrity) {
        return buildClawHubInstallFailure(
          `ClawHub archive integrity mismatch for "${releaseLabel}": expected ${versionState.verification.integrity}, got ${archive.integrity}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
    } else if (versionState.verification) {
      const files = versionState.verification.files;
      const archiveEntries = new Map<string, ArchiveEntryKind>();
      verification = {
        limits: CLAWHUB_ARCHIVE_LIMITS,
        entryFilter: (entry) => {
          if (entry.kind !== "directory") {
            archiveEntries.set(entry.path, entry.kind);
          }
          return "extract";
        },
        onExtractionError: mapClawHubArchiveReadFailure,
        verify: async (extractDir) => {
          const result = await verifyClawHubExtractedFiles({
            extractDir,
            archiveEntries,
            packageName: canonicalPackageName,
            packageVersion: versionState.version,
            files,
          });
          if (!result.ok) {
            return result;
          }
          const validatedPaths = files
            .map((file) => file.path)
            .toSorted()
            .join(", ");
          const validatedGeneratedPaths =
            result.validatedGeneratedPaths.length > 0
              ? ` Validated generated metadata files present in archive: ${result.validatedGeneratedPaths.join(", ")} (JSON parse plus slug/version match only).`
              : "";
          params.logger?.warn?.(
            `ClawHub package "${releaseLabel}" is missing sha256hash; falling back to files[] verification. Validated files: ${validatedPaths}.${validatedGeneratedPaths}`,
          );
          return null;
        },
      };
    }
    const clawhubRegistry = resolveClawHubBaseUrl(params.baseUrl);
    const clawhubAuthority = isDefaultClawHubBaseUrl(params.baseUrl) ? "openclaw" : "third-party";
    const installResult = await installPluginFromArchive<ClawHubInstallFailure>(
      copyPluginInstallTransactionRequest(params, {
        archivePath: archive.archivePath,
        verification,
        onInstallPolicyWarning: params.onInstallPolicyWarning,
        trustedSourceLinkedOfficialInstall: officialClawHubPackage,
        config: params.config,
        logger: params.logger,
        mode: params.mode,
        extensionsDir: params.extensionsDir,
        timeoutMs: params.timeoutMs,
        workTimeoutMs: params.workTimeoutMs,
        dryRun: params.dryRun,
        expectedPluginId: runtimeIdResolution.expectedPluginId,
        beforePersistentApply: params.beforePersistentApply,
        onPluginArtifactInspect: params.onPluginArtifactInspect,
        onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit
          ? (artifact) =>
              params.onBeforePluginArtifactCommit!({
                ...artifact,
                sourceRecord: {
                  source: "clawhub",
                  spec: params.spec,
                  clawhubUrl: clawhubRegistry,
                  clawhubPackage: canonicalPackageName,
                  clawhubChannel: detail.package!.channel,
                  integrity: archive.integrity,
                },
              })
          : undefined,
        installPolicyRequest: {
          kind: "plugin-archive",
          requestedSpecifier: params.spec,
          source: {
            kind: "clawhub",
            authority: officialClawHubPackage ? "official" : clawhubAuthority,
            mutable: false,
            network: true,
          },
        },
      }),
    );
    if (!installResult.ok) {
      return installResult;
    }

    const pkg = detail.package!;
    const clawpackFields = normalizeClawHubClawPackInstallFields(versionState.clawpack);
    const observedClawPackArtifactFields =
      archive.artifact === "clawpack"
        ? ({
            artifactKind: "npm-pack",
            artifactFormat: "tgz",
            ...(archive.npmIntegrity ? { npmIntegrity: archive.npmIntegrity } : {}),
            ...(archive.npmShasum ? { npmShasum: archive.npmShasum } : {}),
            ...(archive.npmTarballName ? { npmTarballName: archive.npmTarballName } : {}),
          } satisfies Partial<ClawHubPluginInstallRecordFields>)
        : ({
            artifactKind: "legacy-zip",
            artifactFormat: "zip",
          } satisfies Partial<ClawHubPluginInstallRecordFields>);
    const expectedTarballName = normalizeOptionalString(versionState.clawpack?.npmTarballName);
    return {
      ...installResult,
      ...(trustResult?.warning ? { warning: trustResult.warning } : {}),
      packageName: canonicalPackageName,
      clawhub: {
        source: "clawhub",
        clawhubUrl: clawhubRegistry,
        clawhubPackage: canonicalPackageName,
        clawhubFamily,
        clawhubChannel: pkg.channel,
        version: installResult.version ?? versionState.version,
        // For fallback installs this is the observed download digest, not a
        // server-attested sha256hash from ClawHub version metadata.
        integrity: archive.integrity,
        resolvedAt: new Date().toISOString(),
        ...clawpackFields,
        ...observedClawPackArtifactFields,
        ...(trustResult ? trustResult.trustInstallRecordFields : {}),
        ...(expectedTarballName && !archive.npmTarballName
          ? { npmTarballName: expectedTarballName }
          : {}),
      },
    };
  } finally {
    await archive.cleanup().catch((error: unknown) => {
      params.logger?.warn?.(
        `Failed to remove temporary ClawHub archive: ${formatErrorMessage(error)}`,
      );
    });
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
