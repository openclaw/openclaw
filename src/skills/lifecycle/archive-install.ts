// Archive install helpers extract and validate skill archives during installation.
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ArchiveLogger } from "../../infra/archive.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { installPackageDir } from "../../infra/install-package-dir.js";
import {
  evaluateSkillInstallPolicy,
  type InstallSecurityScanResult,
} from "../../plugins/install-security-scan.js";
import type { InstallSafetyOverrides } from "../../plugins/install-security-scan.types.js";
import type { InstallPolicyOrigin, InstallPolicySource } from "../../security/install-policy.js";
import { resolveWorkspaceSkillInstallDir } from "./install-paths.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  resolveCommittedSkillChangeSource,
  snapshotCommittedSkillArtifactBestEffort,
} from "./skill-change-hook.js";
import { checkClawHubSkillPlanAtPath } from "./skill-tree-digest.js";
import type {
  WorkspaceSkillLifecycle,
  SkillArchiveInstallResult,
  SkillArchiveInstallFailureKind,
  SkillRootInstallFiles,
  SkillRootApplyResult,
} from "./workspace-types.js";

export type { SkillArchiveInstallFailureKind } from "./workspace-types.js";

const DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS = ["SKILL.md"] as const;
/** Accepted root marker names for ClawHub skill archive uploads. */
export const CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS = [
  "SKILL.md",
  "skill.md",
  "skills.md",
  "SKILL.MD",
] as const;

type SkillArchiveInstallPolicy = {
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  installId?: string;
  origin: InstallPolicyOrigin;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
};

function installFailure(
  error: string,
  failureKind: SkillArchiveInstallFailureKind,
): Extract<SkillArchiveInstallResult, { ok: false }> {
  return { ok: false, error, failureKind };
}

async function hasSkillArchiveRoot(
  rootDir: string,
  rootMarkers: readonly string[],
): Promise<boolean> {
  for (const candidate of rootMarkers) {
    if (await pathExists(path.join(rootDir, candidate))) {
      return true;
    }
  }
  return false;
}

function scanBlockedFailureKind(
  blocked: NonNullable<InstallSecurityScanResult["blocked"]>,
): SkillArchiveInstallFailureKind {
  return blocked.code === "security_scan_failed" ? "unavailable" : "invalid-request";
}

const TRANSIENT_ARCHIVE_ERROR_PATTERNS = [
  "enoent",
  "enospc",
  "eio",
  "eacces",
  "eperm",
  "ebusy",
  "emfile",
  "enfile",
  "timeout",
  "timed out",
] as const;

function archiveFailureKind(error: string): SkillArchiveInstallFailureKind {
  const lower = error.toLowerCase();
  if (lower.startsWith("failed to install skill:")) {
    return "unavailable";
  }
  for (const pattern of TRANSIENT_ARCHIVE_ERROR_PATTERNS) {
    if (lower.includes(pattern)) {
      return "unavailable";
    }
  }
  return "invalid-request";
}

export async function installExtractedSkillRoot(
  params: SkillRootInstallFiles & { policy?: SkillArchiveInstallPolicy },
): Promise<SkillArchiveInstallResult> {
  try {
    const changeSource = resolveCommittedSkillChangeSource(params.policy?.origin.type);
    const sourceVersionValue = params.policy?.origin.version ?? params.policy?.origin.commit;
    const sourceVersion =
      typeof sourceVersionValue === "string" || typeof sourceVersionValue === "number"
        ? String(sourceVersionValue)
        : undefined;
    const captureChanges = hasCommittedSkillChangeHooks();
    const { policy: _policy, ...files } = params;
    const result = await applyExtractedSkillRoot({
      ...files,
      ...(captureChanges ? { changes: { source: changeSource, sourceVersion } } : {}),
      beforeInstall: async (mode) => {
        if (!params.policy) {
          return undefined;
        }
        const scanResult = await evaluateSkillInstallPolicy({
          config: params.policy.config,
          onInstallPolicyWarning: params.policy.onInstallPolicyWarning,
          installId: params.policy.installId ?? "archive",
          logger: params.logger ?? {},
          origin: params.policy.origin,
          requestedSpecifier: params.policy.requestedSpecifier,
          source: params.policy.source,
          mode,
          skillName: params.slug,
          sourceDir: params.extractedRoot,
        });
        return scanResult?.blocked
          ? {
              error: scanResult.blocked.reason,
              failureKind: scanBlockedFailureKind(scanResult.blocked),
            }
          : undefined;
      },
    });
    if (!result.ok) {
      return result;
    }
    if (captureChanges) {
      await dispatchCommittedSkillChangeBestEffort({
        action: result.mode === "update" ? "updated" : "created",
        source: changeSource,
        workspaceDir: params.workspaceDir,
        before: result.before,
        after: result.after,
        logger: params.logger,
      });
    }
    return { ok: true, targetDir: result.targetDir };
  } catch (err) {
    return installFailure(formatErrorMessage(err), "unavailable");
  }
}

/** Native file replacement on the workspace host; policy and hook dispatch stay with the caller. */
async function applyExtractedSkillRoot(
  params: Parameters<WorkspaceSkillLifecycle["applyExtractedSkillRoot"]>[0],
): Promise<SkillRootApplyResult> {
  try {
    if (
      !(await hasSkillArchiveRoot(
        params.extractedRoot,
        params.rootMarkers ?? DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS,
      ))
    ) {
      return installFailure("archive is missing SKILL.md", "invalid-request");
    }
    let targetDir: string;
    try {
      targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
    } catch (err) {
      return installFailure(formatErrorMessage(err), "invalid-request");
    }
    const targetExists = await pathExists(targetDir);
    const effectiveMode = params.mode === "update" && targetExists ? "update" : "install";
    if (params.mode === "install" && targetExists) {
      return installFailure(
        `Skill already exists at ${targetDir}. Re-run with force/update.`,
        "invalid-request",
      );
    }
    const before =
      params.changes && effectiveMode === "update"
        ? await snapshotCommittedSkillArtifactBestEffort({
            skillDir: targetDir,
            skillKey: params.slug,
            source: params.changes.source,
            logger: params.logger,
          })
        : undefined;
    const policyFailure = await params.beforeInstall?.(effectiveMode);
    if (policyFailure) {
      return installFailure(policyFailure.error, policyFailure.failureKind);
    }

    const expectedClawHubState = params.expectedClawHubState;
    let replacementBlocked: string | undefined;
    const install = await installPackageDir({
      sourceDir: params.extractedRoot,
      targetDir,
      mode: effectiveMode,
      timeoutMs: params.timeoutMs ?? 120_000,
      logger: params.logger,
      copyErrorPrefix: "failed to install skill",
      hasDeps: false,
      depsLogMessage: "",
      ...(expectedClawHubState !== undefined
        ? {
            afterBackup: async (backupDir: string) => {
              const current = expectedClawHubState
                ? await checkClawHubSkillPlanAtPath(expectedClawHubState, backupDir)
                : {
                    ok: false as const,
                    error: `Skill ${JSON.stringify(params.slug)} appeared during update.`,
                  };
              replacementBlocked = current.ok
                ? undefined
                : `${current.error} Updating replaces the installed skill directory.`;
              return replacementBlocked
                ? { ok: false as const, error: replacementBlocked }
                : { ok: true as const };
            },
          }
        : {}),
    });
    if (!install.ok) {
      return {
        ...installFailure(install.error, replacementBlocked ? "invalid-request" : "unavailable"),
        ...(replacementBlocked ? { replacementBlocked } : {}),
      };
    }
    const after = params.changes
      ? await snapshotCommittedSkillArtifactBestEffort({
          skillDir: targetDir,
          skillKey: params.slug,
          source: params.changes.source,
          sourceVersion: params.changes.sourceVersion,
          logger: params.logger,
        })
      : undefined;
    return { ok: true, targetDir, mode: effectiveMode, before, after };
  } catch (err) {
    return installFailure(formatErrorMessage(err), "unavailable");
  }
}

export async function installSkillArchiveFromPath(params: {
  archivePath: string;
  workspaceDir: string;
  slug: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: ArchiveLogger;
  policy?: SkillArchiveInstallPolicy;
}): Promise<SkillArchiveInstallResult> {
  const result = await withExtractedArchiveRoot({
    archivePath: params.archivePath,
    tempDirPrefix: "openclaw-skill-archive-",
    timeoutMs: params.timeoutMs ?? 120_000,
    logger: params.logger,
    rootMarkers: ["SKILL.md"],
    onExtracted: async (rootDir) =>
      await installExtractedSkillRoot({
        workspaceDir: params.workspaceDir,
        slug: params.slug,
        extractedRoot: rootDir,
        mode: params.force ? "update" : "install",
        timeoutMs: params.timeoutMs,
        logger: params.logger,
        policy: params.policy,
      }),
  });
  if (!result.ok) {
    const error = result.error.includes("unexpected archive layout")
      ? "archive is missing SKILL.md"
      : result.error;
    const failureKind =
      "failureKind" in result &&
      (result.failureKind === "invalid-request" || result.failureKind === "unavailable")
        ? result.failureKind
        : archiveFailureKind(error);
    return installFailure(error, failureKind);
  }
  return result;
}
