// ClawHub lifecycle facade: public API plus install/update coordination.
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { downloadClawHubSkillArchive } from "../../infra/clawhub-artifacts.js";
import type { ClawHubTrustErrorCode } from "../../infra/clawhub-install-trust.js";
import { normalizeClawHubSha256Integrity } from "../../infra/clawhub-integrity.js";
import {
  fetchClawHubSkillVerification,
  type ClawHubSkillVerificationResponse,
} from "../../infra/clawhub-skills.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { InstallSafetyOverrides } from "../../plugins/install-security-scan.types.js";
import { withClawPackageLifecycleLease } from "../../state/claw-package-lifecycle-lease.js";
import {
  checkClawHubSkillTrust,
  isDefaultOfficialClawHubSkillSource,
  normalizeExpectedArtifactIntegrity,
  performClawHubSkillInstall,
  resolveInstallVersion,
  type ClawHubInstallParams,
  type InstallClawHubSkillResult,
  type Logger,
} from "./clawhub-install-core.js";
import { formatClawHubSkillRequestError } from "./clawhub-request-error.js";
import {
  preflightSkillOwnerState,
  resolveRequestedUpdateSlug,
  resolveTrackedUpdateTarget,
  type ClawHubSkillInstallPreflightResult,
} from "./clawhub-status.js";
import {
  parseRequestedClawHubSkillRef,
  readClawHubSkillsLockfile,
  resolveWorkspaceClawHubSkills,
} from "./clawhub-store.js";
import {
  guardTrackedSkillLocalState,
  type ClawHubSkillUninstallPlan,
} from "./clawhub-uninstall.js";
import { normalizeTrackedSkillSlug } from "./install-paths.js";

export { readVerifiedClawHubSkillSourceUrl } from "./clawhub-install-core.js";
export {
  resolveClawHubSkillVerificationTarget,
  searchSkillsFromClawHub,
} from "./clawhub-status.js";
export { readTrackedClawHubSkillSlugs } from "./clawhub-store.js";

export async function verifySkillWithClawHub(
  params: Parameters<typeof fetchClawHubSkillVerification>[0],
): Promise<Result<ClawHubSkillVerificationResponse, string>> {
  try {
    return ok(await fetchClawHubSkillVerification(params));
  } catch (error) {
    return resultError(
      formatClawHubSkillRequestError(error, { slug: params.slug, operation: "verify" }),
    );
  }
}

type UpdateClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      previousVersion: string | null;
      version: string;
      changed: boolean;
      targetDir: string;
      warning?: string;
    }
  | {
      ok: false;
      error: string;
      code?: ClawHubTrustErrorCode | "force_required";
      version?: string;
      warning?: string;
    };

async function installRequestedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const ref = parseRequestedClawHubSkillRef(params.slug);
    if (ref.requestedReference && params.version) {
      throw new Error("--version is not supported for skills-sh references.");
    }
    return await performClawHubSkillInstall({
      ...params,
      slug: ref.slug,
      ...(ref.ownerHandle ? { ownerHandle: ref.ownerHandle } : {}),
      ...(ref.requestedReference ? { requestedReference: ref.requestedReference } : {}),
      ...(ref.trustState ? { trustState: ref.trustState } : {}),
    });
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

async function installTrackedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: normalizeTrackedSkillSlug(params.slug),
    });
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

export async function preflightSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version: string;
  expectedIntegrity?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<ClawHubSkillInstallPreflightResult> {
  try {
    const tracking = resolveWorkspaceClawHubSkills(params.workspaceDir);
    const preflightOwner = tracking?.preflightSkillOwnerState ?? preflightSkillOwnerState;
    const requested = parseRequestedClawHubSkillRef(params.slug);
    const resolved = await resolveInstallVersion({
      slug: requested.slug,
      ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      version: params.version,
      baseUrl: params.baseUrl,
    });
    if (resolved.version !== params.version) {
      return {
        ok: false,
        code: "skill_version_resolution_mismatch",
        error: `Skill ${params.slug}@${params.version} resolved to ${resolved.version}.`,
      };
    }
    const trust = await checkClawHubSkillTrust({
      workspaceDir: params.workspaceDir,
      slug: requested.slug,
      ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      version: resolved.version,
      baseUrl: params.baseUrl,
      logger: params.logger,
      skipClawHubTrustCheck: isDefaultOfficialClawHubSkillSource({
        baseUrl: params.baseUrl,
        detail: resolved.detail,
      }),
    });
    if (!trust.ok) {
      return {
        ok: false,
        code: trust.code ?? "skill_trust_required",
        error: trust.error,
      };
    }

    if (params.expectedIntegrity) {
      const integrity = normalizeExpectedArtifactIntegrity(params.expectedIntegrity);
      const owner = await preflightOwner({
        workspaceDir: params.workspaceDir,
        requested,
        requestedLabel: params.slug,
        version: resolved.version,
        integrity,
      });
      return owner.ok && trust.warning ? { ...owner, warning: trust.warning } : owner;
    }

    const archive = await downloadClawHubSkillArchive({
      slug: requested.slug,
      ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      version: resolved.version,
      baseUrl: params.baseUrl,
    });
    try {
      const integrity = normalizeClawHubSha256Integrity(archive.integrity);
      if (!integrity) {
        return {
          ok: false,
          code: "skill_integrity_unavailable",
          error: `Skill ${params.slug}@${params.version} did not resolve a valid artifact integrity.`,
        };
      }
      const owner = await preflightOwner({
        workspaceDir: params.workspaceDir,
        requested,
        requestedLabel: params.slug,
        version: resolved.version,
        integrity,
      });
      return owner.ok && trust.warning ? { ...owner, warning: trust.warning } : owner;
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, code: "skill_preflight_failed", error: formatErrorMessage(err) };
  }
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
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
}): Promise<InstallClawHubSkillResult> {
  if (params.clawManaged) {
    return await installRequestedSkillFromClawHub(params);
  }
  return await withClawPackageLifecycleLease(
    { kind: "skill", source: "clawhub", ref: params.slug, workspace: params.workspaceDir },
    () => installRequestedSkillFromClawHub(params),
  );
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  force?: boolean;
  forceInstall?: boolean;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
}): Promise<UpdateClawHubSkillResult[]> {
  const tracking = resolveWorkspaceClawHubSkills(params.workspaceDir);
  const lock = await (tracking?.readClawHubSkillsLockfile ?? readClawHubSkillsLockfile)(
    params.workspaceDir,
  );
  const slugs = params.slug
    ? [
        await (tracking?.resolveRequestedUpdateSlug ?? resolveRequestedUpdateSlug)({
          workspaceDir: params.workspaceDir,
          requestedSlug: params.slug,
          lock,
        }),
      ]
    : Object.keys(lock.skills).map((slug) => normalizeTrackedSkillSlug(slug));
  const results: UpdateClawHubSkillResult[] = [];
  for (const slug of slugs) {
    const tracked = await (tracking?.resolveTrackedUpdateTarget ?? resolveTrackedUpdateTarget)({
      workspaceDir: params.workspaceDir,
      slug,
      lock,
      baseUrl: params.baseUrl,
    });
    if (!tracked.ok) {
      results.push({ ok: false, error: tracked.error });
      continue;
    }
    const install = await withClawPackageLifecycleLease(
      { kind: "skill", source: "clawhub", ref: tracked.slug, workspace: params.workspaceDir },
      async () => {
        let localPlan: ClawHubSkillUninstallPlan | undefined;
        if (!params.force) {
          // Carry the verified digests into the install transaction. Re-resolving the
          // live path after download would leave another check-to-backup race.
          const local = await (
            tracking?.guardTrackedSkillLocalState ?? guardTrackedSkillLocalState
          )({
            workspaceDir: params.workspaceDir,
            slug: tracked.slug,
            previousVersion: tracked.previousVersion,
          });
          if (!local.ok) {
            return {
              ok: false as const,
              code: "force_required" as const,
              error: `${local.error} Updating replaces the installed skill directory.`,
            };
          }
          localPlan = local.plan;
        }
        const installed = await installTrackedSkillFromClawHub({
          workspaceDir: params.workspaceDir,
          slug: tracked.slug,
          ...(tracked.ownerHandle ? { ownerHandle: tracked.ownerHandle } : {}),
          ...(tracked.requestedReference ? { requestedReference: tracked.requestedReference } : {}),
          ...(tracked.trustState ? { trustState: tracked.trustState } : {}),
          baseUrl: tracked.baseUrl,
          force: true,
          forceInstall: params.forceInstall,
          logger: params.logger,
          config: params.config,
          onInstallPolicyWarning: params.onInstallPolicyWarning,
          ...(params.force ? {} : { expectedClawHubState: localPlan ?? null }),
        });
        if (!installed.ok && installed.replacementBlocked) {
          return {
            ok: false as const,
            code: "force_required" as const,
            error: installed.replacementBlocked,
          };
        }
        return installed;
      },
      { required: true },
    );
    results.push(
      install.ok
        ? {
            ok: true,
            slug: tracked.slug,
            previousVersion: tracked.previousVersion,
            version: install.version,
            changed: tracked.previousVersion !== install.version,
            targetDir: install.targetDir,
            ...(install.warning ? { warning: install.warning } : {}),
          }
        : install,
    );
  }
  return results;
}
