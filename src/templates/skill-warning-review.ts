import type { TemplateAddPlan } from "./types.js";

export function collectTemplateSkillWarningReviews(plan: TemplateAddPlan) {
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
      typeof details.integrity !== "string"
    ) {
      throw new Error("The Template skill trust review is incomplete.");
    }
    return [
      {
        actionId: action.id,
        ref: details.ref,
        version: details.version,
        integrity: details.integrity,
        riskWarning: details.riskWarning,
      },
    ];
  });
}
