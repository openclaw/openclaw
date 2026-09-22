import fsSync from "node:fs";
import path from "node:path";
import {
  getAgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../../infra/boundary-file-read.js";
import { resolveClawHubBaseUrl } from "../../infra/clawhub-client.js";
import {
  CLAWHUB_SKILLS_SH_TRUST_STATE,
  CLAWHUB_SKILLS_SH_REF_PREFIX,
  searchClawHubSkills,
  type ClawHubSkillSearchResult,
} from "../../infra/clawhub-skills.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import {
  normalizeDownloadedArtifactLock,
  normalizeOptionalStringValue,
  normalizeSkillFileLock,
  normalizeStoredRegistry,
  parseRequestedClawHubSkillRef,
  readClawHubSkillOriginStatusSync,
  readClawHubSkillOriginStrict,
  readClawHubSkillOrigin,
  readClawHubSkillsLockfile,
  readClawHubSkillsLockfileStatusSync,
  type ClawHubSkillsLockfileStatusRead,
} from "./clawhub-store.js";
import {
  normalizeTrackedSkillSlug,
  resolveWorkspaceSkillInstallDir,
  validateRequestedSkillSlug,
} from "./install-paths.js";
import type {
  WorkspaceSkillLifecycle,
  ClawHubSkillStatusLink,
  LocalSkillCardStatus,
  ClawHubSkillVerificationSelector,
  ClawHubSkillVerificationTargetResult,
  ClawHubSkillInstallPreflightResult,
  TrackedUpdateTarget,
} from "./workspace-types.js";

export type { ClawHubSkillInstallPreflightResult } from "./workspace-types.js";

const LOCAL_SKILL_CARD_FILENAME = "skill-card.md";
const LOCAL_SKILL_CARD_MAX_BYTES = 256 * 1024;

type LocalSkillCardRead = LocalSkillCardStatus & { content?: string };

function readRealPathSync(candidate: string): string | undefined {
  try {
    return fsSync.realpathSync.native(candidate);
  } catch {
    return undefined;
  }
}

function invalidLink(
  reason: string,
  details: Omit<Extract<ClawHubSkillStatusLink, { valid: false }>, "status" | "valid" | "reason">,
): ClawHubSkillStatusLink {
  return { status: "invalid", valid: false, reason, ...details };
}

export function resolveClawHubSkillStatusLinkSync(params: {
  workspaceDir: string;
  skillDir: string;
  skillKey: string;
  lockRead?: ClawHubSkillsLockfileStatusRead;
  lockfileScope?: "workspace" | "managed";
}): ClawHubSkillStatusLink | undefined {
  const originRead = readClawHubSkillOriginStatusSync(params.skillDir);
  const lockRead = params.lockRead ?? readClawHubSkillsLockfileStatusSync(params.workspaceDir);
  const lockfileLabel = `${params.lockfileScope ?? "workspace"} ClawHub lockfile`;
  if (originRead.kind === "missing") {
    let trackedSlug: string;
    try {
      trackedSlug = normalizeTrackedSkillSlug(params.skillKey);
    } catch {
      return undefined;
    }
    const locked = lockRead.kind === "found" ? lockRead.lock.skills[trackedSlug] : undefined;
    if (!locked) {
      return undefined;
    }
    return invalidLink(
      `Skill "${trackedSlug}" is tracked by the ${lockfileLabel} but is missing local ClawHub origin metadata.`,
      {
        slug: trackedSlug,
        installedVersion: locked.version,
        installedAt: locked.installedAt,
        registry: normalizeStoredRegistry(locked.registry ?? resolveClawHubBaseUrl()),
        lockPath: lockRead.kind === "found" ? lockRead.path : undefined,
      },
    );
  }
  if (originRead.kind === "malformed") {
    return invalidLink(
      `Malformed ClawHub origin metadata at ${originRead.path}: ${originRead.error}`,
      {
        originPath: originRead.path,
        lockPath: lockRead.kind === "found" ? lockRead.path : undefined,
      },
    );
  }

  const originDetails = {
    registry: originRead.origin.registry,
    installedVersion: originRead.origin.installedVersion,
    installedAt: originRead.origin.installedAt,
    originPath: originRead.path,
  };
  let trackedSlug: string;
  try {
    trackedSlug = normalizeTrackedSkillSlug(originRead.origin.slug);
  } catch (err) {
    return invalidLink(
      `Invalid ClawHub origin slug "${originRead.origin.slug}": ${formatErrorMessage(err)}`,
      {
        ...originDetails,
        slug: originRead.origin.slug,
        lockPath: lockRead.kind === "found" ? lockRead.path : undefined,
      },
    );
  }

  if (lockRead.kind === "missing") {
    return invalidLink(
      `Skill "${trackedSlug}" has ClawHub origin metadata but is not tracked by the ${lockfileLabel}.`,
      { ...originDetails, slug: trackedSlug },
    );
  }
  if (lockRead.kind === "malformed") {
    return invalidLink(`Malformed ${lockfileLabel} at ${lockRead.path}: ${lockRead.error}`, {
      ...originDetails,
      slug: trackedSlug,
      lockPath: lockRead.path,
    });
  }
  const locked = lockRead.lock.skills[trackedSlug];
  if (!locked) {
    return invalidLink(
      `Skill "${trackedSlug}" has ClawHub origin metadata but is not tracked by the ${lockfileLabel}.`,
      { ...originDetails, slug: trackedSlug, lockPath: lockRead.path },
    );
  }
  const expectedSkillDir = readRealPathSync(
    resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug),
  );
  if (!expectedSkillDir || readRealPathSync(params.skillDir) !== expectedSkillDir) {
    return invalidLink(
      `Skill "${trackedSlug}" ClawHub origin metadata is not in the expected ClawHub install directory.`,
      { ...originDetails, slug: trackedSlug, lockPath: lockRead.path },
    );
  }
  const originRegistry = normalizeStoredRegistry(originRead.origin.registry);
  const lockedRegistry =
    locked.registry === undefined ? originRegistry : normalizeStoredRegistry(locked.registry);
  const sourceUrl = normalizeOptionalStringValue(locked.sourceUrl);
  const ownerHandle = normalizeOptionalStringValue(locked.ownerHandle);
  const requestedReference = normalizeOptionalStringValue(locked.requestedReference);
  const trustState =
    locked.trustState === CLAWHUB_SKILLS_SH_TRUST_STATE ? CLAWHUB_SKILLS_SH_TRUST_STATE : undefined;
  const artifact = normalizeDownloadedArtifactLock(locked.artifact);
  const skillFile = normalizeSkillFileLock(locked.skillFile);
  const fileTreeSha256 = normalizeOptionalStringValue(locked.fileTreeSha256);
  // A linked status is a trust signal. Only expose provenance when both
  // install records agree, so a one-sided origin edit cannot become trusted.
  const provenanceMatches =
    originRead.origin.ownerHandle === ownerHandle &&
    originRead.origin.requestedReference === requestedReference &&
    originRead.origin.trustState === trustState &&
    originRead.origin.sourceUrl === sourceUrl &&
    originRead.origin.artifact?.kind === artifact?.kind &&
    originRead.origin.artifact?.sha256 === artifact?.sha256 &&
    originRead.origin.artifact?.integrity === artifact?.integrity &&
    originRead.origin.skillFile?.path === skillFile?.path &&
    originRead.origin.skillFile?.sha256 === skillFile?.sha256 &&
    originRead.origin.fileTreeSha256 === fileTreeSha256;
  if (
    locked.version !== originRead.origin.installedVersion ||
    locked.installedAt !== originRead.origin.installedAt ||
    lockedRegistry !== originRegistry ||
    !provenanceMatches
  ) {
    return invalidLink(
      `Skill "${trackedSlug}" ClawHub origin metadata does not match the ${lockfileLabel}.`,
      {
        ...originDetails,
        registry: lockedRegistry,
        slug: trackedSlug,
        lockPath: lockRead.path,
      },
    );
  }
  return {
    status: "linked",
    valid: true,
    registry: lockedRegistry,
    slug: trackedSlug,
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(requestedReference ? { requestedReference } : {}),
    ...(trustState ? { trustState } : {}),
    installedVersion: locked.version,
    installedAt: locked.installedAt,
    originPath: originRead.path,
    lockPath: lockRead.path,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(artifact ? { artifact } : {}),
    ...(skillFile ? { skillFile } : {}),
    ...(fileTreeSha256 ? { fileTreeSha256 } : {}),
  };
}

function readLocalSkillCardSync(
  skillDir: string,
  includeContent = false,
): LocalSkillCardRead | undefined {
  const cardPath = path.join(skillDir, LOCAL_SKILL_CARD_FILENAME);
  let fd: number | undefined;
  try {
    const opened = openRootFileSync({
      absolutePath: cardPath,
      rootPath: skillDir,
      boundaryLabel: "skill directory",
      maxBytes: LOCAL_SKILL_CARD_MAX_BYTES,
      rejectHardlinks: false,
    });
    if (!opened.ok) {
      return undefined;
    }
    fd = opened.fd;
    const result: LocalSkillCardRead = {
      present: true,
      path: cardPath,
      sizeBytes: opened.stat.size,
    };
    if (includeContent) {
      result.content = readFileDescriptorBoundedSync(fd, LOCAL_SKILL_CARD_MAX_BYTES).toString(
        "utf8",
      );
    }
    return result;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // ignore close errors while reporting the card as unavailable
      }
    }
  }
}

export function resolveLocalSkillCardStatusSync(
  skillDir: string,
): LocalSkillCardStatus | undefined {
  return readLocalSkillCardSync(skillDir);
}

export function readLocalSkillCardContentSync(skillDir: string): string | undefined {
  return readLocalSkillCardSync(skillDir, true)?.content;
}

function normalizeOptionalSelector(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export async function searchSkillsFromClawHub(params: {
  query?: string;
  limit?: number;
  baseUrl?: string;
}): Promise<ClawHubSkillSearchResult[]> {
  return await searchClawHubSkills({
    query: params.query?.trim() ?? "",
    limit: params.limit,
    baseUrl: params.baseUrl,
  });
}

export async function resolveClawHubSkillVerificationTarget(
  params: Parameters<WorkspaceSkillLifecycle["resolveClawHubSkillVerificationTarget"]>[0],
): Promise<ClawHubSkillVerificationTargetResult> {
  try {
    const workspaceAccess = getAgentWorkspaceAccess(params.workspaceDir, "loadSkills");
    const access = workspaceAccess?.loadSkills ? workspaceAccess : undefined;
    if (access) {
      if (!access.clawHubSkills) {
        throw new WorkspaceAccessUnavailableError(
          "Remote workspace ClawHub tracking is unavailable",
        );
      }
      return await access.clawHubSkills.resolveClawHubSkillVerificationTarget({
        ...params,
        // Keep Gateway registry configuration when the skill has no installed origin.
        baseUrl: resolveClawHubBaseUrl(params.baseUrl),
      });
    }
    const version = normalizeOptionalSelector(params.version);
    const tag = normalizeOptionalSelector(params.tag);
    if (version && tag) {
      return { ok: false, error: "Use either --version or --tag." };
    }
    const requestedRef = parseRequestedClawHubSkillRef(params.slug);
    if (requestedRef.requestedReference && (version || tag)) {
      return {
        ok: false,
        error: "--version and --tag are not supported for skills-sh references.",
      };
    }
    const trackedSlug = requestedRef.slug;
    const skillDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug);
    const originRead = await readClawHubSkillOriginStrict(skillDir);
    if (originRead.kind === "malformed") {
      return {
        ok: false,
        error: `Malformed ClawHub origin metadata at ${originRead.path}: ${originRead.error}`,
      };
    }

    if (originRead.kind === "found") {
      const locked = (await readClawHubSkillsLockfile(params.workspaceDir)).skills[trackedSlug];
      if (!locked) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" has ClawHub origin metadata but is not tracked by the workspace ClawHub lockfile. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      const originSlug = normalizeTrackedSkillSlug(originRead.origin.slug);
      if (originSlug !== trackedSlug) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" has ClawHub origin metadata for "${originRead.origin.slug}". Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      const originRegistry = normalizeStoredRegistry(originRead.origin.registry);
      const lockedRegistry =
        locked.registry === undefined ? originRegistry : normalizeStoredRegistry(locked.registry);
      const ownerHandle = normalizeOptionalStringValue(locked.ownerHandle);
      const requestedReference = normalizeOptionalStringValue(locked.requestedReference);
      const trustState =
        locked.trustState === CLAWHUB_SKILLS_SH_TRUST_STATE
          ? CLAWHUB_SKILLS_SH_TRUST_STATE
          : undefined;
      if (
        locked.version !== originRead.origin.installedVersion ||
        locked.installedAt !== originRead.origin.installedAt ||
        lockedRegistry !== originRegistry ||
        originRead.origin.ownerHandle !== ownerHandle ||
        originRead.origin.requestedReference !== requestedReference ||
        originRead.origin.trustState !== trustState
      ) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" ClawHub origin metadata does not match the workspace ClawHub lockfile. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      if (requestedReference && (version || tag)) {
        return {
          ok: false,
          error: "--version and --tag are not supported for skills-sh references.",
        };
      }
      if (requestedRef.ownerHandle && ownerHandle !== requestedRef.ownerHandle) {
        const trackedRef = ownerHandle ? `@${ownerHandle}/${trackedSlug}` : trackedSlug;
        return {
          ok: false,
          error: `Skill "${trackedSlug}" is tracked as ${trackedRef}, not @${requestedRef.ownerHandle}/${trackedSlug}.`,
        };
      }
      if (
        requestedRef.requestedReference &&
        requestedReference !== requestedRef.requestedReference
      ) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" is not tracked from ${requestedRef.requestedReference}.`,
        };
      }
      const selector: ClawHubSkillVerificationSelector = version
        ? "version"
        : tag
          ? "tag"
          : "installed-version";
      // ClawHub's skills.sh verify route accepts the catalog reference as its sole selector.
      // It rejects version/tag; the stored commit remains local installed provenance.
      const verificationVersion = requestedReference
        ? undefined
        : (version ?? (tag ? undefined : locked.version));
      return {
        ok: true,
        slug: trackedSlug,
        ...(ownerHandle ? { ownerHandle } : {}),
        ...(requestedReference ? { requestedReference } : {}),
        ...(trustState ? { trustState } : {}),
        baseUrl: lockedRegistry,
        version: verificationVersion,
        tag: requestedReference ? undefined : tag,
        resolution: {
          source: "installed",
          selector,
          registry: lockedRegistry,
          skillDir,
          installedVersion: locked.version,
        },
      };
    }

    const lockRead = readClawHubSkillsLockfileStatusSync(params.workspaceDir);
    if (lockRead.kind === "malformed") {
      return {
        ok: false,
        error: `Malformed workspace ClawHub lockfile at ${lockRead.path}: ${lockRead.error}`,
      };
    }
    if (lockRead.kind === "found" && lockRead.lock.skills[trackedSlug]) {
      return {
        ok: false,
        error: `Skill "${trackedSlug}" is tracked by the workspace ClawHub lockfile but is missing ClawHub origin metadata. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
      };
    }
    const registry = resolveClawHubBaseUrl(params.baseUrl);
    const selector: ClawHubSkillVerificationSelector = version ? "version" : tag ? "tag" : "latest";
    return {
      ok: true,
      slug: requestedRef.slug,
      ...(requestedRef.ownerHandle ? { ownerHandle: requestedRef.ownerHandle } : {}),
      ...(requestedRef.requestedReference
        ? { requestedReference: requestedRef.requestedReference }
        : {}),
      ...(requestedRef.trustState ? { trustState: requestedRef.trustState } : {}),
      baseUrl: registry,
      version,
      tag,
      resolution: {
        source: "registry",
        selector,
        registry,
        skillDir: undefined,
        installedVersion: undefined,
      },
    };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

export async function preflightSkillOwnerState(
  params: Parameters<WorkspaceSkillLifecycle["preflightSkillOwnerState"]>[0],
): Promise<ClawHubSkillInstallPreflightResult> {
  const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.requested.slug);
  if (!(await pathExists(targetDir))) {
    return { ok: true, action: "install", integrity: params.integrity };
  }
  const status = resolveClawHubSkillStatusLinkSync({
    workspaceDir: params.workspaceDir,
    skillDir: targetDir,
    skillKey: params.requested.slug,
  });
  if (
    status?.status === "linked" &&
    status.installedVersion === params.version &&
    status.ownerHandle === params.requested.ownerHandle &&
    status.artifact?.integrity === params.integrity
  ) {
    return { ok: true, action: "reuse", integrity: params.integrity };
  }
  return {
    ok: false,
    code: "skill_version_conflict",
    error: `Skill ${params.requestedLabel}@${params.version} conflicts with the existing workspace skill at ${targetDir}.`,
  };
}

export async function resolveRequestedUpdateSlug(
  params: Parameters<WorkspaceSkillLifecycle["resolveRequestedUpdateSlug"]>[0],
): Promise<string> {
  const requested = params.requestedSlug.trim();
  const requestedRef =
    requested.startsWith("@") || requested.startsWith(CLAWHUB_SKILLS_SH_REF_PREFIX)
      ? parseRequestedClawHubSkillRef(requested)
      : { slug: normalizeTrackedSkillSlug(requested) };
  const trackedSlug = requestedRef.slug;
  const trackedOrigin = await readClawHubSkillOrigin(
    resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug),
  );
  const trackedLockEntry = params.lock.skills[trackedSlug];
  if (!trackedOrigin && !trackedLockEntry) {
    return validateRequestedSkillSlug(requestedRef.slug);
  }
  const trackedOwnerHandle = trackedOrigin?.ownerHandle ?? trackedLockEntry?.ownerHandle;
  if (requestedRef.ownerHandle && trackedOwnerHandle !== requestedRef.ownerHandle) {
    const trackedRef = trackedOwnerHandle ? `@${trackedOwnerHandle}/${trackedSlug}` : trackedSlug;
    throw new Error(
      `Skill "${trackedSlug}" is tracked as ${trackedRef}, not @${requestedRef.ownerHandle}/${trackedSlug}.`,
    );
  }
  const trackedRequestedReference =
    trackedOrigin?.requestedReference ?? trackedLockEntry?.requestedReference;
  if (
    requestedRef.requestedReference &&
    trackedRequestedReference !== requestedRef.requestedReference
  ) {
    throw new Error(
      `Skill "${trackedSlug}" is not tracked from ${requestedRef.requestedReference}.`,
    );
  }
  return trackedSlug;
}

export async function resolveTrackedUpdateTarget(
  params: Parameters<WorkspaceSkillLifecycle["resolveTrackedUpdateTarget"]>[0],
): Promise<TrackedUpdateTarget> {
  const origin = await readClawHubSkillOrigin(
    resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug),
  );
  const lockEntry = params.lock.skills[params.slug];
  if (!origin && !lockEntry) {
    return {
      ok: false,
      slug: params.slug,
      error: `Skill "${params.slug}" is not tracked as a ClawHub install.`,
    };
  }
  const ownerHandle = origin?.ownerHandle ?? lockEntry?.ownerHandle;
  const requestedReference = origin?.requestedReference ?? lockEntry?.requestedReference;
  const trustState = origin?.trustState ?? lockEntry?.trustState;
  return {
    ok: true,
    slug: params.slug,
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(requestedReference ? { requestedReference } : {}),
    ...(trustState ? { trustState } : {}),
    baseUrl: origin?.registry ?? params.baseUrl,
    previousVersion: origin?.installedVersion ?? lockEntry?.version ?? null,
  };
}
