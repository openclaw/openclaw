import { clawTargetPackages } from "../claws/application-provenance.js";
import type { ClawSkillInstallConsent } from "../claws/packages.js";
import type {
  ClawAddPlan,
  ClawManifest,
  ClawOpenClawProfile,
  ClawPackagePreflightResult,
} from "../claws/types.js";
import type { ClawUpdatePlan } from "../claws/update-plan-types.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";

export type ClawCliSkillWarning = {
  ref: string;
  version: string;
  integrity: string;
  riskWarning: string;
};

export function addPlanSkillWarnings(plan: ClawAddPlan): ClawCliSkillWarning[] {
  return plan.actions.flatMap((action) => {
    const details = action.details;
    if (
      action.kind !== "package" ||
      action.blocked ||
      details?.kind !== "skill" ||
      details.ownerAction !== "install" ||
      typeof details.riskWarning !== "string" ||
      !details.riskWarning
    ) {
      return [];
    }
    if (
      typeof details.ref !== "string" ||
      typeof details.version !== "string" ||
      typeof details.integrity !== "string" ||
      action.id !== `skill:${details.ref}`
    ) {
      throw new Error("The Claw skill trust review is incomplete.");
    }
    return [
      {
        ref: details.ref,
        version: details.version,
        integrity: details.integrity,
        riskWarning: details.riskWarning,
      },
    ];
  });
}

export function updatePlanSkillWarnings(params: {
  plan: ClawUpdatePlan;
  manifest: ClawManifest;
  profile?: ClawOpenClawProfile;
  preflights: ReadonlyMap<string, ClawPackagePreflightResult>;
}): ClawCliSkillWarning[] {
  const targets = clawTargetPackages(params.manifest, params.profile);
  return params.plan.actions.flatMap((action) => {
    if (
      action.kind !== "package" ||
      !action.id.startsWith("skill:") ||
      action.blocked ||
      (action.action !== "add" && action.action !== "change")
    ) {
      return [];
    }
    const target = targets.get(action.id);
    const preflight = params.preflights.get(action.id);
    if (!target || target.kind !== "skill" || !preflight?.ok) {
      throw new Error("The Claw skill trust review is incomplete.");
    }
    if (!preflight.warning || preflight.action === "reuse") {
      return [];
    }
    if (preflight.action !== "install" || !preflight.integrity) {
      throw new Error("The Claw skill trust review is incomplete.");
    }
    return [
      {
        ref: target.ref,
        version: target.version,
        integrity: preflight.integrity,
        riskWarning: preflight.warning,
      },
    ];
  });
}

export function logClawSkillWarnings(
  warnings: readonly ClawCliSkillWarning[],
  runtime: RuntimeEnv,
): void {
  if (warnings.length === 0) {
    return;
  }
  runtime.log(`Skill trust warnings (${warnings.length}):`);
  for (const warning of warnings) {
    runtime.log(redactSensitiveText(`  ${warning.ref}@${warning.version} (${warning.integrity})`));
    runtime.log(redactSensitiveText(`    ${warning.riskWarning}`));
  }
  runtime.log("The plan integrity binds each skill warning above.");
}

export function consentToClawSkillWarnings(
  warnings: readonly ClawCliSkillWarning[],
): ClawSkillInstallConsent | undefined {
  if (warnings.length === 0) {
    return undefined;
  }
  const byRef = new Map<string, ClawCliSkillWarning>();
  for (const warning of warnings) {
    if (byRef.has(warning.ref)) {
      throw new Error("The Claw skill trust review contains a duplicate package.");
    }
    byRef.set(warning.ref, warning);
  }
  return {
    assertApproved: (pkg) => {
      const reviewed = byRef.get(pkg.ref);
      if (
        !reviewed ||
        reviewed.version !== pkg.version ||
        reviewed.integrity !== pkg.integrity ||
        reviewed.riskWarning !== pkg.riskWarning
      ) {
        throw new Error("Skill trust state changed; review the Claw again.");
      }
    },
  };
}
