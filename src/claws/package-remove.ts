import { runPluginUninstallCommand } from "../cli/plugins-uninstall-command.js";
import { resolveInstalledClawHubPlugin } from "../plugins/plugin-install-preflight.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  applyClawHubSkillUninstall,
  planClawHubSkillUninstall,
  type ClawHubSkillUninstallPlan,
} from "../skills/lifecycle/clawhub-uninstall.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readClawPackageRefs,
  updateClawPackageRefStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";

type ClawPackageRemovalDecision = {
  packageRef: PersistedClawPackageRef;
  action: "uninstall" | "retain";
  reason?: string;
  pluginId?: string;
  skillPlan?: ClawHubSkillUninstallPlan;
};

export type ClawPackageRemovalResult = {
  kind: PersistedClawPackageRef["kind"];
  ref: string;
  version: string;
  action: "uninstalled" | "retained" | "error";
  reason?: string;
};

export type PackageRemovalDeps = {
  readPackageRefs?: typeof readClawPackageRefs;
  claimPackageRef?: typeof updateClawPackageRefStatus;
  resolvePlugin?: typeof resolveInstalledClawHubPlugin;
  planSkill?: typeof planClawHubSkillUninstall;
  uninstallPlugin?: typeof runPluginUninstallCommand;
  uninstallSkill?: typeof applyClawHubSkillUninstall;
};

type ClawPackageState = "present" | "missing" | "modified" | "ambiguous" | "incomplete";
export type ClawPackageInspection = PersistedClawPackageRef & {
  state: ClawPackageState;
  message?: string;
};

function sameArtifact(left: PersistedClawPackageRef, right: PersistedClawPackageRef): boolean {
  return left.kind === right.kind && left.source === right.source && left.ref === right.ref;
}

function sameVersionedArtifact(
  left: PersistedClawPackageRef,
  right: PersistedClawPackageRef,
): boolean {
  return sameArtifact(left, right) && left.version === right.version;
}

function ownerInstallIsNewer(
  installedAt: string | number | undefined,
  packageRef: PersistedClawPackageRef,
): boolean {
  const timestamp = typeof installedAt === "number" ? installedAt : Date.parse(installedAt ?? "");
  return Number.isFinite(timestamp) && timestamp > packageRef.updatedAtMs;
}

export async function inspectClawPackage(
  install: PersistedClawInstall,
  packageRef: PersistedClawPackageRef,
  deps: PackageRemovalDeps = {},
): Promise<ClawPackageInspection> {
  if (packageRef.status !== "complete") {
    return { ...packageRef, state: "incomplete", message: "Package installation is incomplete." };
  }
  if (packageRef.kind === "plugin") {
    const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
      clawhubPackage: packageRef.ref,
    });
    if (resolution.status !== "found") {
      return {
        ...packageRef,
        state: resolution.status,
        message:
          resolution.status === "ambiguous"
            ? "Installed plugin identity is ambiguous."
            : "Installed plugin is missing.",
      };
    }
    if (resolution.installedVersion !== packageRef.version) {
      return {
        ...packageRef,
        state: "modified",
        message: "Installed plugin version changed after the Claw was added.",
      };
    }
    return {
      ...packageRef,
      ownership: ownerInstallIsNewer(resolution.record.installedAt, packageRef)
        ? "independently-owned"
        : packageRef.ownership,
      state: "present",
    };
  }
  const skill = await (deps.planSkill ?? planClawHubSkillUninstall)({
    workspaceDir: install.workspace,
    slug: packageRef.ref,
    expectedVersion: packageRef.version,
  });
  return skill.ok
    ? {
        ...packageRef,
        ownership: ownerInstallIsNewer(skill.plan.installedAt, packageRef)
          ? "independently-owned"
          : packageRef.ownership,
        state: "present",
      }
    : { ...packageRef, state: skill.code, message: skill.error };
}

export async function planClawPackageRemovals(
  install: PersistedClawInstall,
  packages: PersistedClawPackageRef[],
  options: OpenClawStateDatabaseOptions & { deps?: PackageRemovalDeps } = {},
): Promise<ClawPackageRemovalDecision[]> {
  const deps = options.deps ?? {};
  const allRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
  const decisions: ClawPackageRemovalDecision[] = [];
  for (const packageRef of packages) {
    const retain = (reason: string): void => {
      decisions.push({ packageRef, action: "retain", reason });
    };
    if (packageRef.status !== "complete") {
      retain("Package installation is incomplete.");
      continue;
    }
    if (packageRef.ownership !== "claw-installed") {
      retain("Package is independently owned outside this Claw.");
      continue;
    }
    if (
      packageRef.kind === "plugin" &&
      allRefs.some(
        (candidate) =>
          candidate.agentId !== packageRef.agentId && sameArtifact(candidate, packageRef),
      )
    ) {
      retain("Another Claw still references this package.");
      continue;
    }
    if (packageRef.kind === "plugin") {
      const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
        clawhubPackage: packageRef.ref,
      });
      if (resolution.status !== "found") {
        retain(
          resolution.status === "ambiguous"
            ? "Installed plugin identity is ambiguous."
            : "Installed plugin is missing.",
        );
        continue;
      }
      if (resolution.installedVersion !== packageRef.version) {
        retain("Installed plugin version changed after the Claw was added.");
        continue;
      }
      if (ownerInstallIsNewer(resolution.record.installedAt, packageRef)) {
        retain("Package is independently owned outside this Claw.");
        continue;
      }
      decisions.push({
        packageRef,
        action: "uninstall",
        pluginId: resolution.pluginId,
      });
      continue;
    }
    const skill = await (deps.planSkill ?? planClawHubSkillUninstall)({
      workspaceDir: install.workspace,
      slug: packageRef.ref,
      expectedVersion: packageRef.version,
    });
    if (!skill.ok) {
      retain(skill.error);
      continue;
    }
    if (ownerInstallIsNewer(skill.plan.installedAt, packageRef)) {
      retain("Package is independently owned outside this Claw.");
      continue;
    }
    decisions.push({ packageRef, action: "uninstall", skillPlan: skill.plan });
  }
  return decisions;
}

export async function applyClawPackageRemovals(
  decisions: ClawPackageRemovalDecision[],
  options: OpenClawStateDatabaseOptions & { deps?: PackageRemovalDeps } = {},
): Promise<ClawPackageRemovalResult[]> {
  const deps = options.deps ?? {};
  const results: ClawPackageRemovalResult[] = [];
  for (const decision of decisions) {
    const base = {
      kind: decision.packageRef.kind,
      ref: decision.packageRef.ref,
      version: decision.packageRef.version,
    };
    if (decision.action === "retain") {
      results.push({ ...base, action: "retained", reason: decision.reason });
      continue;
    }
    try {
      const currentRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
      const currentRef = currentRefs.find(
        (candidate) =>
          candidate.agentId === decision.packageRef.agentId &&
          sameVersionedArtifact(candidate, decision.packageRef),
      );
      const sharedPlugin =
        decision.packageRef.kind === "plugin" &&
        currentRefs.some(
          (candidate) =>
            candidate.agentId !== decision.packageRef.agentId &&
            sameArtifact(candidate, decision.packageRef) &&
            candidate.status === "complete",
        );
      if (
        !currentRef ||
        currentRef.status !== "complete" ||
        currentRef.ownership !== "claw-installed" ||
        sharedPlugin
      ) {
        throw new Error(
          `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed after removal planning.`,
        );
      }
      (deps.claimPackageRef ?? updateClawPackageRefStatus)(currentRef, "pending", options);
      const postClaimRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
      const postClaimRef = postClaimRefs.find(
        (candidate) =>
          candidate.agentId === decision.packageRef.agentId &&
          sameVersionedArtifact(candidate, decision.packageRef),
      );
      const postClaimShared =
        decision.packageRef.kind === "plugin" &&
        postClaimRefs.some(
          (candidate) =>
            candidate.agentId !== decision.packageRef.agentId &&
            sameArtifact(candidate, decision.packageRef) &&
            candidate.status === "complete",
        );
      if (
        !postClaimRef ||
        postClaimRef.status !== "pending" ||
        postClaimRef.ownership !== "claw-installed" ||
        postClaimShared
      ) {
        throw new Error(
          `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed while claiming removal.`,
        );
      }
      if (decision.packageRef.kind === "skill") {
        if (!decision.skillPlan) {
          throw new Error("Skill uninstall plan is missing.");
        }
        const removed = await (deps.uninstallSkill ?? applyClawHubSkillUninstall)(
          decision.skillPlan,
        );
        if (!removed.ok) {
          throw new Error(removed.error);
        }
      } else {
        const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
          clawhubPackage: decision.packageRef.ref,
        });
        if (
          resolution.status !== "found" ||
          resolution.pluginId !== decision.pluginId ||
          resolution.installedVersion !== decision.packageRef.version
        ) {
          throw new Error(
            `Plugin ${decision.packageRef.ref}@${decision.packageRef.version} changed after removal planning.`,
          );
        }
        const runtime: RuntimeEnv = {
          log: () => undefined,
          error: () => undefined,
          exit: (code) => {
            throw new Error(`Plugin uninstall exited with code ${code}.`);
          },
        };
        await (deps.uninstallPlugin ?? runPluginUninstallCommand)(
          decision.pluginId ?? `clawhub:${decision.packageRef.ref}`,
          { force: true, invalidateRuntimeCache: false },
          runtime,
        );
      }
      (deps.claimPackageRef ?? updateClawPackageRefStatus)(
        decision.packageRef,
        "complete",
        options,
      );
      results.push({ ...base, action: "uninstalled" });
    } catch (error) {
      try {
        (deps.claimPackageRef ?? updateClawPackageRefStatus)(
          decision.packageRef,
          "complete",
          options,
        );
      } catch {
        // Preserve the original cleanup failure as the actionable result.
      }
      results.push({
        ...base,
        action: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
