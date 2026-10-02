import { stableStringify } from "@openclaw/normalization-core";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import type { ClawPackageStatus } from "./lifecycle-status.js";
import { planOwnedClawSkillUpgrade } from "./owned-skill-upgrade.js";
import type { PersistedClawInstall, PersistedClawPackageRef } from "./provenance.js";
import type {
  ClawAddPlanAction,
  ClawDiagnostic,
  ClawManifest,
  ClawOpenClawProfile,
  ClawPackage,
  ClawPackagePreflight,
  ClawPackagePreflightResult,
} from "./types.js";

export function isApplicationUpdateBlocker(entry: ClawDiagnostic): boolean {
  return (
    entry.code !== "workspace_collision" &&
    entry.code !== "agent_id_collision" &&
    !entry.path.startsWith("$.packages")
  );
}

export function clawPackageKey(value: Pick<ClawPackage, "kind" | "ref">): string {
  return `${value.kind}:${value.ref}`;
}

export function recordingClawPackagePreflight(
  preflight: ClawPackagePreflight | undefined,
  workspace: string,
  results: Map<string, ClawPackagePreflightResult>,
  currentPackages: ReadonlyMap<string, ClawPackageStatus>,
  allPackages: readonly PersistedClawPackageRef[] = [],
  allInstalls: readonly Pick<PersistedClawInstall, "agentId" | "workspace">[] = [],
): ClawPackagePreflight {
  return async (pkg) => {
    const result = preflight
      ? await preflight(pkg, workspace)
      : {
          ok: false as const,
          code: "package_install_unavailable",
          message: "Package preflight is unavailable.",
        };
    const current = currentPackages.get(clawPackageKey(pkg));
    const ownedSkillUpgrade =
      !result.ok &&
      pkg.kind === "skill" &&
      result.code === "skill_version_conflict" &&
      current?.state === "present" &&
      current.version !== pkg.version &&
      result.integrity &&
      normalizeClawHubSha256Integrity(result.integrity)
        ? await planOwnedClawSkillUpgrade({
            workspace,
            previous: current,
            targetVersion: pkg.version,
            refs: allPackages,
            installs: allInstalls,
          })
        : undefined;
    const ownedSkillConflict = ownedSkillUpgrade?.ok === true;
    const normalized =
      ownedSkillConflict ||
      (!result.ok &&
        pkg.kind === "plugin" &&
        result.code === "plugin_version_conflict" &&
        current?.state === "present" &&
        current.origin === "claw-introduced" &&
        !current.independentOwner &&
        current.version !== pkg.version &&
        result.installedVersion === current.version)
        ? { ...result, ok: true as const, action: "install" as const }
        : result;
    results.set(clawPackageKey(pkg), normalized);
    return normalized;
  };
}

function clawProfileExtensionPackages(profile: ClawOpenClawProfile | undefined): ClawPackage[] {
  return (profile?.extensions ?? []).map((extension) => ({
    kind: "plugin",
    source: extension.source,
    ref: extension.ref,
    version: extension.version,
  }));
}

export function clawTargetPackages(
  manifest: ClawManifest,
  profile: ClawOpenClawProfile | undefined,
) {
  return new Map(
    [...manifest.packages, ...clawProfileExtensionPackages(profile)].map(
      (pkg) => [clawPackageKey(pkg), pkg] as const,
    ),
  );
}

export function clawWorkspaceActionsById(actions: ClawAddPlanAction[]) {
  return new Map(
    actions
      .filter((action) => action.kind === "workspaceFile")
      .map((action) => [action.id, action] as const),
  );
}

export function clawPackageActionsById(actions: ClawAddPlanAction[]) {
  return new Map(
    actions
      .filter((action) => action.kind === "package")
      .map((action) => [action.id, action] as const),
  );
}

export function clawExtensionProvenanceChanged(
  current: PersistedClawPackageRef["extension"],
  target: ClawAddPlanAction | undefined,
): boolean {
  return stableStringify(current ?? null) !== stableStringify(target?.details?.extension ?? null);
}
