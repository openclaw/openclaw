import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { clawTargetPackages } from "./application-provenance.js";
import { digestClawValue } from "./digest.js";
import type {
  ClawAddPlan,
  ClawManifest,
  ClawOpenClawProfile,
  ClawPackagePreflight,
} from "./types.js";
import type { ClawUpdateAction, ClawUpdatePlan } from "./update-plan-types.js";

export function comparableUpdatePlan(plan: ClawUpdatePlan): unknown {
  return {
    found: plan.found,
    agentId: plan.agentId,
    currentClaw: plan.currentClaw,
    targetClaw: plan.targetClaw,
    actions: plan.actions,
    capabilityChanges: plan.capabilityChanges,
    readiness: plan.readiness,
    blockers: plan.blockers,
  };
}

export function updatePackagePreflight(
  plan: ClawUpdatePlan,
  packagePreflight?: ClawPackagePreflight,
): ClawPackagePreflight {
  return async (pkg, workspace) => {
    const preflight = packagePreflight
      ? await packagePreflight(pkg, workspace)
      : {
          ok: false,
          code: "package_install_unavailable",
          message: "Package preflight is unavailable.",
        };
    const action = plan.actions.find(
      (candidate) => candidate.kind === "package" && candidate.id === `${pkg.kind}:${pkg.ref}`,
    );
    return !preflight.ok &&
      action?.action === "change" &&
      ((pkg.kind === "plugin" && preflight.code === "plugin_version_conflict") ||
        (pkg.kind === "skill" &&
          preflight.code === "skill_version_conflict" &&
          preflight.integrity &&
          normalizeClawHubSha256Integrity(preflight.integrity)))
      ? {
          ok: true,
          action: "install" as const,
          ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
          ...(preflight.installId ? { installId: preflight.installId } : {}),
          ...(preflight.warning ? { warning: preflight.warning } : {}),
          ...(preflight.declaredCapabilities
            ? { declaredCapabilities: preflight.declaredCapabilities }
            : {}),
          ...(preflight.capabilityGrants ? { capabilityGrants: preflight.capabilityGrants } : {}),
          ...(preflight.capabilityGrantsByPluginId
            ? { capabilityGrantsByPluginId: preflight.capabilityGrantsByPluginId }
            : {}),
          ...(preflight.requirements ? { requirements: preflight.requirements } : {}),
          ...(preflight.detectedFormat ? { detectedFormat: preflight.detectedFormat } : {}),
          ...(preflight.mapped ? { mapped: preflight.mapped } : {}),
          ...(preflight.unavailable ? { unavailable: preflight.unavailable } : {}),
          ...(preflight.adapterIdentity ? { adapterIdentity: preflight.adapterIdentity } : {}),
        }
      : preflight;
  };
}

export function inspectUpdateTargetPackages(params: {
  plan: ClawUpdatePlan;
  addPlan: ClawAddPlan;
  manifest: ClawManifest;
  profile?: ClawOpenClawProfile;
}):
  | { ok: true; targetPackages: ReturnType<typeof clawTargetPackages> }
  | { ok: false; code: "update_target_blocked" | "update_changed"; message: string } {
  const { plan, addPlan, manifest, profile } = params;
  const unchangedIds = new Set(
    plan.actions
      .filter((action) => action.kind === "package" && action.action === "unchanged")
      .map((action) => action.id),
  );
  const unchangedPaths = new Set<string>();
  manifest.packages.forEach((pkg, index) => {
    if (unchangedIds.has(`${pkg.kind}:${pkg.ref}`)) {
      unchangedPaths.add(`$.packages[${index}]`);
    }
  });
  if (
    addPlan.blockers.some(
      (blocker) =>
        blocker.code !== "agent_id_collision" &&
        blocker.code !== "workspace_collision" &&
        !(blocker.code === "skill_version_conflict" && unchangedPaths.has(blocker.path)),
    )
  ) {
    return {
      ok: false,
      code: "update_target_blocked",
      message: "The target Claw cannot be safely materialized for update.",
    };
  }
  for (const action of plan.actions.filter(
    (candidate) => candidate.kind === "package" && candidate.action === "unchanged",
  )) {
    const addAction = addPlan.actions.find(
      (candidate) => candidate.kind === "package" && candidate.id === action.id,
    );
    if (!addAction || addAction.details?.expectedState === "absent") {
      return {
        ok: false,
        code: "update_changed",
        message: `Package ${JSON.stringify(action.id)} is no longer present; build a new dry-run plan.`,
      };
    }
  }
  const targetPackages = clawTargetPackages(manifest, profile);
  for (const action of plan.actions.filter(
    (candidate) =>
      candidate.kind === "package" &&
      candidate.action !== "unchanged" &&
      candidate.action !== "release" &&
      candidate.action !== "remove",
  )) {
    const target = targetPackages.get(action.id);
    const addAction = addPlan.actions.find(
      (candidate) => candidate.kind === "package" && candidate.id === action.id,
    );
    const details = addAction?.details;
    if (
      !target ||
      action.desiredDigest !==
        digestClawValue({
          package: target,
          integrity: details?.integrity,
          installId: details?.installId,
          riskWarning: details?.riskWarning,
          prerequisites: details?.prerequisites,
          declaredCapabilities: details?.declaredCapabilities,
          capabilityGrants: details?.capabilityGrants,
          capabilityGrantsByPluginId: details?.capabilityGrantsByPluginId,
          extension: details?.extension,
        })
    ) {
      return {
        ok: false,
        code: "update_changed",
        message: `Resolved package ${JSON.stringify(action.id)} changed after update planning; build a new dry-run plan.`,
      };
    }
  }
  return { ok: true, targetPackages };
}

export function inspectUpdatePluginRequirements(params: {
  plan: ClawUpdatePlan;
  addPlan: ClawAddPlan;
  targetPackages: ReturnType<typeof clawTargetPackages>;
  requirementActions: ClawUpdateAction[];
  resume: boolean;
  captureOwners: boolean;
}):
  | { ok: true; resumedRequirements: string[]; requiredPluginIds: string[] }
  | { ok: false; message: string } {
  const { plan, addPlan, targetPackages, requirementActions, resume, captureOwners } = params;
  const installIdFor = (action: ClawUpdateAction) => {
    const installId = addPlan.actions.find((entry) => entry.id === action.id)?.details?.installId;
    return typeof installId === "string" && installId ? installId : undefined;
  };
  const resumedRequirements: string[] = [];
  if (resume) {
    for (const action of plan.actions.filter(
      (candidate) =>
        candidate.kind === "package" &&
        candidate.action === "unchanged" &&
        targetPackages.get(candidate.id)?.kind === "plugin",
    )) {
      const installId = installIdFor(action);
      if (!installId) {
        return {
          ok: false,
          message: `Plugin requirement ${action.id} lost its installed identity; build a new dry-run plan.`,
        };
      }
      resumedRequirements.push(installId);
    }
  }
  const requiredPluginIds = [...resumedRequirements];
  if (captureOwners) {
    for (const action of requirementActions) {
      const installId = installIdFor(action);
      if (!installId) {
        return {
          ok: false,
          message: `Plugin requirement ${action.id} lost its installed identity; build a new dry-run plan.`,
        };
      }
      requiredPluginIds.push(installId);
    }
  }
  return {
    ok: true,
    resumedRequirements,
    requiredPluginIds: [...new Set(requiredPluginIds)],
  };
}
