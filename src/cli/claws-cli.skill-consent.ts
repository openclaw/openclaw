import type { ClawSkillInstallConsent } from "../claws/packages.js";
import { collectClawSkillWarningReviews } from "../claws/skill-warning-review.js";
import type { ClawAddPlan } from "../claws/types.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";

export type ClawCliSkillWarning = {
  ref: string;
  version: string;
  integrity: string;
  riskWarning: string;
};

export function addPlanSkillWarnings(plan: ClawAddPlan): ClawCliSkillWarning[] {
  return collectClawSkillWarningReviews(plan).map(({ actionId, ...warning }) => {
    if (actionId !== `skill:${warning.ref}`) {
      throw new Error("The Claw skill trust review is incomplete.");
    }
    return warning;
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
  runtime.log("These warnings require explicit acknowledgement before Add.");
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
