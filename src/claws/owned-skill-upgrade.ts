import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { resolveClawHubSkillStatusLinkSync } from "../skills/lifecycle/clawhub-status.js";
import { parseRequestedClawHubSkillRef } from "../skills/lifecycle/clawhub-store.js";
import { planClawHubSkillUninstall } from "../skills/lifecycle/clawhub-uninstall.js";
import { resolveWorkspaceSkillInstallDir } from "../skills/lifecycle/install-paths.js";
import type { ClawHubSkillUninstallPlan } from "../skills/lifecycle/workspace-types.js";
import type { PersistedClawInstall, PersistedClawPackageRef } from "./provenance.js";

type SkillOwnerInput = {
  workspace: string;
  previous: PersistedClawPackageRef;
  refs: readonly PersistedClawPackageRef[];
  installs: readonly Pick<PersistedClawInstall, "agentId" | "workspace">[];
};

function skillSlug(ref: string): string | undefined {
  try {
    return parseRequestedClawHubSkillRef(ref).slug;
  } catch {
    return undefined;
  }
}

export function hasOtherWorkspaceSkillOwner(params: SkillOwnerInput): boolean {
  const slug = skillSlug(params.previous.ref);
  if (!slug) {
    return true;
  }
  const workspaces = new Map(
    params.installs.map((install) => [install.agentId, install.workspace]),
  );
  return params.refs.some((candidate) => {
    if (
      candidate.kind !== "skill" ||
      candidate.source !== "clawhub" ||
      candidate.status === "rolled_back" ||
      skillSlug(candidate.ref) !== slug ||
      (candidate.agentId === params.previous.agentId && candidate.ref === params.previous.ref)
    ) {
      return false;
    }
    const otherWorkspace = workspaces.get(candidate.agentId);
    return !otherWorkspace || otherWorkspace === params.workspace;
  });
}

export async function planOwnedClawSkillUpgrade(
  params: SkillOwnerInput & { targetVersion: string },
): Promise<
  | { ok: true; plan: ClawHubSkillUninstallPlan }
  | { ok: false; code: "skill_shared" | "skill_not_owned" | "skill_drifted"; message: string }
> {
  const { previous } = params;
  if (
    previous.kind !== "skill" ||
    previous.source !== "clawhub" ||
    previous.status !== "complete" ||
    previous.relationship !== "managed" ||
    previous.origin !== "claw-introduced" ||
    previous.independentOwner ||
    previous.version === params.targetVersion
  ) {
    return {
      ok: false,
      code: "skill_not_owned",
      message: "Only an exclusively Claw-managed skill may be upgraded in place.",
    };
  }
  if (hasOtherWorkspaceSkillOwner(params)) {
    return {
      ok: false,
      code: "skill_shared",
      message: "Another Claw shares this workspace skill and blocks its replacement.",
    };
  }
  const requested = parseRequestedClawHubSkillRef(previous.ref);
  const link = resolveClawHubSkillStatusLinkSync({
    workspaceDir: params.workspace,
    skillDir: resolveWorkspaceSkillInstallDir(params.workspace, requested.slug),
    skillKey: requested.slug,
  });
  const recordedIntegrity = normalizeClawHubSha256Integrity(previous.integrity);
  const installedIntegrity =
    link?.valid && link.artifact?.integrity
      ? normalizeClawHubSha256Integrity(link.artifact.integrity)
      : null;
  if (
    !link?.valid ||
    link.installedVersion !== previous.version ||
    link.ownerHandle !== requested.ownerHandle ||
    link.requestedReference !== requested.requestedReference ||
    !recordedIntegrity ||
    installedIntegrity !== recordedIntegrity ||
    link.installedAt > previous.updatedAtMs
  ) {
    return {
      ok: false,
      code: "skill_drifted",
      message: "Installed skill provenance no longer matches this Claw's recorded artifact.",
    };
  }
  const planned = await planClawHubSkillUninstall({
    workspaceDir: params.workspace,
    slug: previous.ref,
    expectedVersion: previous.version,
  });
  return planned.ok
    ? { ok: true, plan: planned.plan }
    : { ok: false, code: "skill_drifted", message: planned.error };
}
