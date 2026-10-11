import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  downloadClawHubGitHubSkillArchive,
  downloadClawHubSkillArchive,
  downloadClawHubSkillArchiveUrl,
  type ClawHubDownloadResult,
} from "../../infra/clawhub-artifacts.js";
import { isDefaultClawHubBaseUrl, resolveClawHubBaseUrl } from "../../infra/clawhub-client.js";
import {
  checkClawHubPackageTrust,
  type ClawHubTrustErrorCode,
} from "../../infra/clawhub-install-trust.js";
import { normalizeClawHubSha256Integrity } from "../../infra/clawhub-integrity.js";
import {
  CLAWHUB_SKILLS_SH_TRUST_LABEL,
  CLAWHUB_SKILLS_SH_TRUST_STATE,
  fetchClawHubSkillDetail,
  fetchClawHubSkillInstallResolution,
  fetchClawHubSkillVerification,
  reportClawHubSkillInstallTelemetry,
  type ClawHubSkillDetail,
  type ClawHubSkillInstallResolutionResponse,
} from "../../infra/clawhub-skills.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import type { InstallSafetyOverrides } from "../../plugins/install-security-scan.types.js";
import { markClawPackageIndependentlyOwned } from "../../state/claw-package-adoption.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
  installExtractedSkillRoot,
} from "./archive-install.js";
import { formatClawHubSkillRequestError } from "./clawhub-request-error.js";
import {
  formatClawHubSkillRef,
  normalizeGitHubCommitSegment,
  normalizeOptionalStringValue,
  assertClawHubSkillInstallState,
  readInstalledClawHubSkillFiles,
  recordClawHubSkillInstall,
  type ClawHubSkillVerificationLock,
  resolveWorkspaceClawHubSkills,
} from "./clawhub-store.js";
import type { ClawHubSkillFileState } from "./skill-tree-digest.js";
import type { ClawHubSkillRef } from "./workspace-types.js";

export type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  terminalLinks?: boolean;
};

export type ClawHubInstallParams = ClawHubSkillRef & {
  workspaceDir: string;
  version?: string;
  expectedIntegrity?: string;
  baseUrl?: string;
  force?: boolean;
  forceInstall?: boolean;
  confirmInstall?: () => boolean | Promise<boolean>;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  /** True when a Claw lifecycle caller already owns package coordination. */
  clawManaged?: boolean;
  expectedClawHubState?: ClawHubSkillFileState | null;
};

export type InstallClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      version: string;
      targetDir: string;
      detail?: ClawHubSkillDetail;
      warning?: string;
    }
  | {
      ok: false;
      error: string;
      code?: ClawHubTrustErrorCode;
      version?: string;
      warning?: string;
      replacementBlocked?: string;
    };

export function normalizeExpectedArtifactIntegrity(expectedIntegrity: string): string {
  const normalized = normalizeClawHubSha256Integrity(expectedIntegrity);
  if (!normalized) {
    throw new Error(`Invalid expected ClawHub archive integrity: ${expectedIntegrity}`);
  }
  return normalized;
}

type ClawHubOfficialFlagContainer = {
  channel?: unknown;
  official?: unknown;
  isOfficial?: unknown;
};

function hasOfficialClawHubFlag(value: ClawHubOfficialFlagContainer | null | undefined): boolean {
  return value?.channel === "official" || value?.official === true || value?.isOfficial === true;
}

export function isDefaultOfficialClawHubSkillSource(params: {
  baseUrl?: string;
  detail?: ClawHubSkillDetail;
  resolution?: Extract<ClawHubSkillInstallResolutionResponse, { ok: true }>;
}): boolean {
  if (!isDefaultClawHubBaseUrl(params.baseUrl)) {
    return false;
  }
  return (
    hasOfficialClawHubFlag(params.detail?.skill) ||
    hasOfficialClawHubFlag(params.detail?.owner) ||
    hasOfficialClawHubFlag(params.resolution) ||
    (params.resolution?.installKind === "archive" &&
      hasOfficialClawHubFlag(params.resolution.archive))
  );
}

export async function resolveInstallVersion(params: {
  slug: string;
  ownerHandle?: string;
  version?: string;
  baseUrl?: string;
}): Promise<{ detail: ClawHubSkillDetail; version: string }> {
  const detail = await fetchClawHubSkillDetail({
    slug: params.slug,
    ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
    baseUrl: params.baseUrl,
  });
  if (!detail.skill) {
    throw new Error(`Skill "${params.slug}" not found on ClawHub.`);
  }
  const version = params.version ?? detail.latestVersion?.version;
  if (!version) {
    throw new Error(`Skill "${params.slug}" has no installable version.`);
  }
  return { detail, version };
}

function normalizeGitHubSourcePath(raw: string): string {
  const parts = raw.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid GitHub skill source path: ${raw}`);
  }
  return parts.join("/");
}

export function readVerifiedClawHubSkillSourceUrl(raw: unknown): string | undefined {
  const provenance =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  // Only this ClawHub variant is server-resolved; other provenance metadata
  // must not become a trusted source link.
  if (provenance?.source !== "server-resolved-github-import") {
    return undefined;
  }
  const repo = normalizeOptionalStringValue(provenance.repo);
  const repoParts = repo?.split("/");
  const commit = normalizeGitHubCommitSegment(provenance.commit);
  if (
    !repo ||
    repoParts?.length !== 2 ||
    repoParts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part)) ||
    !commit
  ) {
    return undefined;
  }
  const pathValue = normalizeOptionalStringValue(provenance.path);
  try {
    const sourcePath = pathValue ? normalizeGitHubSourcePath(pathValue) : undefined;
    const segments = [...repoParts, "tree", commit, ...(sourcePath?.split("/") ?? [])];
    return `https://github.com/${segments.map(encodeURIComponent).join("/")}`;
  } catch {
    return undefined;
  }
}

async function fetchInstallVerificationLock(params: {
  slug: string;
  ownerHandle?: string;
  requestedReference?: string;
  version?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<ClawHubSkillVerificationLock | undefined> {
  try {
    const verification = await fetchClawHubSkillVerification({
      slug: params.slug,
      ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
      ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
      version: params.version,
      baseUrl: params.baseUrl,
    });
    return {
      schema: verification.schema,
      ok: verification.ok,
      decision: verification.decision,
      reasons: [...verification.reasons],
      ...(verification.card !== undefined ? { card: verification.card } : {}),
      ...(verification.artifact !== undefined ? { artifact: verification.artifact } : {}),
      ...(verification.provenance !== undefined ? { provenance: verification.provenance } : {}),
      ...(verification.security !== undefined ? { security: verification.security } : {}),
      ...(verification.signature !== undefined ? { signature: verification.signature } : {}),
    };
  } catch (err) {
    params.logger?.warn?.(
      `Skill verification for ${formatClawHubSkillRef(params)} failed: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

export async function checkClawHubSkillTrust(
  params: ClawHubInstallParams & { version: string; skipClawHubTrustCheck?: boolean },
): Promise<
  | { ok: true; warning?: string }
  | { ok: false; error: string; code?: ClawHubTrustErrorCode; warning?: string }
> {
  if (params.skipClawHubTrustCheck) {
    return { ok: true };
  }
  const result = await checkClawHubPackageTrust({
    subject: {
      kind: "skill",
      packageName: params.slug,
      ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
    },
    version: params.version,
    baseUrl: params.baseUrl,
    logger: params.logger,
    mode: params.force ? "update" : "install",
    confirmInstall: params.confirmInstall,
  });
  return result.ok
    ? { ok: true, ...(result.warning ? { warning: result.warning } : {}) }
    : {
        ok: false,
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.warning ? { warning: result.warning } : {}),
      };
}

export async function performClawHubSkillInstall(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const expectedIntegrity =
      params.expectedIntegrity === undefined
        ? undefined
        : normalizeExpectedArtifactIntegrity(params.expectedIntegrity);
    const files = resolveWorkspaceClawHubSkills(params.workspaceDir);
    const registry = resolveClawHubBaseUrl(params.baseUrl);
    await (files?.assertClawHubSkillInstallState ?? assertClawHubSkillInstallState)({
      workspaceDir: params.workspaceDir,
      slug: params.slug,
      force: params.force,
    });

    let version: string;
    let detail: ClawHubSkillDetail | undefined;
    let resolution: Extract<ClawHubSkillInstallResolutionResponse, { ok: true }> | undefined;
    let trustWarning: string | undefined;
    let official = false;
    let archive: ClawHubDownloadResult;
    if (params.version) {
      const resolved = await resolveInstallVersion(params);
      detail = resolved.detail;
      version = resolved.version;
      official = isDefaultOfficialClawHubSkillSource({ baseUrl: params.baseUrl, detail });
    } else {
      const resolved = await fetchClawHubSkillInstallResolution({
        slug: params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
        baseUrl: params.baseUrl,
        ...(params.forceInstall ? { forceInstall: true } : {}),
      });
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous_slug") {
          const message = resolved.message ? ` ${resolved.message}` : "";
          throw new Error(
            `Skill "${resolved.slug}" is ambiguous on ClawHub. Install an owner-qualified skill, for example: openclaw skills install @owner/${resolved.slug}.${message}`,
          );
        }
        throw new Error(resolved.message || `Skill "${resolved.slug}" is not installable.`);
      }
      resolution = resolved;
      if (resolution.installKind === "github") {
        const commit = normalizeGitHubCommitSegment(resolution.github.commit)?.toLowerCase();
        if (!commit) {
          throw new Error(
            `Skill "${resolution.slug}" resolved to a mutable or invalid GitHub source ref; expected a full 40-character commit SHA.`,
          );
        }
        resolution = { ...resolution, github: { ...resolution.github, commit } };
      }
      if (params.requestedReference) {
        if (
          resolution.installKind !== "github" ||
          resolution.trust?.state !== CLAWHUB_SKILLS_SH_TRUST_STATE
        ) {
          throw new Error(
            `Skill "${params.slug}" did not resolve to an unscanned, commit-pinned GitHub source.`,
          );
        }
        trustWarning = CLAWHUB_SKILLS_SH_TRUST_LABEL;
        params.logger?.warn?.(CLAWHUB_SKILLS_SH_TRUST_LABEL);
      }
      const resolutionOfficial = isDefaultOfficialClawHubSkillSource({
        baseUrl: params.baseUrl,
        resolution,
      });
      if (!resolutionOfficial && isDefaultClawHubBaseUrl(params.baseUrl)) {
        const request = {
          baseUrl: params.baseUrl,
          slug: params.slug,
          ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        };
        try {
          const candidate = await fetchClawHubSkillDetail(request);
          detail = isDefaultOfficialClawHubSkillSource({
            baseUrl: request.baseUrl,
            detail: candidate,
          })
            ? candidate
            : undefined;
        } catch {
          detail = undefined;
        }
      }
      official = isDefaultOfficialClawHubSkillSource({
        baseUrl: params.baseUrl,
        detail,
        resolution,
      });
      version =
        resolution.installKind === "github" ? resolution.github.commit : resolution.archive.version;
    }

    if (resolution?.installKind === "github") {
      // GitHub-backed skills are commit resolutions; their resolver owns scan/force policy.
      params.logger?.info?.(`Downloading ${params.slug}@${version} from GitHub…`);
      archive = await downloadClawHubGitHubSkillArchive({
        repo: resolution.github.repo,
        commit: resolution.github.commit,
      });
    } else {
      const trust = await checkClawHubSkillTrust({
        ...params,
        version,
        skipClawHubTrustCheck: official,
      });
      if (!trust.ok) {
        return { ...trust, version };
      }
      trustWarning = trust.warning;
      params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
      archive = resolution
        ? await downloadClawHubSkillArchiveUrl({
            url: resolution.archive.downloadUrl,
            baseUrl: params.baseUrl,
          })
        : await downloadClawHubSkillArchive({
            slug: params.slug,
            ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
            version,
            baseUrl: params.baseUrl,
          });
    }

    try {
      if (expectedIntegrity && archive.integrity !== expectedIntegrity) {
        throw new Error(
          `ClawHub archive integrity mismatch: expected ${expectedIntegrity}, got ${archive.integrity}.`,
        );
      }
      const github = resolution?.installKind === "github" ? resolution.github : undefined;
      const authority = official
        ? "official"
        : !github && isDefaultClawHubBaseUrl(params.baseUrl)
          ? "openclaw"
          : "third-party";
      const installParams = { ...params };
      const install = await withExtractedArchiveRoot({
        archivePath: archive.archivePath,
        tempDirPrefix: github ? "openclaw-skill-clawhub-github-" : "openclaw-skill-clawhub-",
        timeoutMs: 120_000,
        // GitHub paths are relative to the repository root; select before checking skill markers.
        ...(github ? {} : { rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS }),
        onExtracted: async (rootDir) => {
          const result = await installExtractedSkillRoot({
            workspaceDir: installParams.workspaceDir,
            slug: installParams.slug,
            extractedRoot: github
              ? path.join(rootDir, ...normalizeGitHubSourcePath(github.path).split("/"))
              : rootDir,
            mode: installParams.force ? "update" : "install",
            logger: installParams.logger,
            expectedClawHubState: installParams.expectedClawHubState,
            policy: {
              config: installParams.config,
              onInstallPolicyWarning: installParams.onInstallPolicyWarning,
              installId: "clawhub",
              origin: {
                type: "clawhub",
                registry,
                slug: installParams.slug,
                ...(installParams.ownerHandle ? { ownerHandle: installParams.ownerHandle } : {}),
                version,
                ...(github
                  ? {
                      repo: github.repo,
                      path: github.path,
                      commit: github.commit,
                      ...(installParams.requestedReference
                        ? { reference: installParams.requestedReference }
                        : {}),
                      ...(installParams.trustState ? { trustState: installParams.trustState } : {}),
                    }
                  : {}),
              },
              source: {
                kind: github ? "git" : "clawhub",
                authority,
                mutable: false,
                network: true,
              },
              requestedSpecifier:
                (github ? installParams.requestedReference : undefined) ??
                `clawhub:${formatClawHubSkillRef(installParams)}@${version}`,
            },
            rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
          });
          return result.ok
            ? result
            : ({
                ok: false,
                error: result.error,
                ...(result.replacementBlocked !== undefined
                  ? { replacementBlocked: result.replacementBlocked }
                  : {}),
              } satisfies InstallClawHubSkillResult);
        },
      });
      if (!install.ok) {
        return install;
      }

      const installedAt = Date.now();
      const artifact = {
        kind: archive.artifact,
        sha256: archive.sha256Hex,
        integrity: archive.integrity,
      };
      const [{ skillFile, fileTreeSha256 }, verification] = await Promise.all([
        (files?.readInstalledClawHubSkillFiles ?? readInstalledClawHubSkillFiles)({
          skillDir: install.targetDir,
        }),
        fetchInstallVerificationLock({
          slug: params.slug,
          ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
          ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
          version: github ? undefined : version,
          baseUrl: params.baseUrl,
          logger: params.logger,
        }),
      ]);
      const sourceUrl =
        (resolution?.installKind === "github"
          ? normalizeOptionalStringValue(resolution.github.sourceUrl)
          : undefined) ?? readVerifiedClawHubSkillSourceUrl(verification?.provenance);
      const trackedMetadata = {
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
        ...(params.trustState ? { trustState: params.trustState } : {}),
        installedAt,
        ...(sourceUrl ? { sourceUrl } : {}),
        artifact,
        ...(skillFile ? { skillFile } : {}),
        fileTreeSha256,
      };
      await (files?.recordClawHubSkillInstall ?? recordClawHubSkillInstall)({
        workspaceDir: params.workspaceDir,
        skillDir: install.targetDir,
        origin: {
          version: 1,
          registry,
          slug: params.slug,
          ...trackedMetadata,
          installedVersion: version,
        },
        verification,
      });
      if (!params.clawManaged) {
        await markClawPackageIndependentlyOwned({
          kind: "skill",
          source: "clawhub",
          ref: formatClawHubSkillRef(params),
          version,
          workspace: params.workspaceDir,
        });
      }
      await reportClawHubSkillInstallTelemetry({
        baseUrl: params.baseUrl,
        slug: params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        version,
        ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
        ...(params.trustState ? { trustState: params.trustState } : {}),
      }).catch(() => undefined);
      return {
        ok: true,
        slug: params.slug,
        version,
        targetDir: install.targetDir,
        ...(detail ? { detail } : {}),
        ...(trustWarning ? { warning: trustWarning } : {}),
      };
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      error: formatClawHubSkillRequestError(err, { slug: params.slug, operation: "install" }),
    };
  }
}
