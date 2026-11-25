import type { TemplateSkillWarning } from "./package-install-options.js";
import type { TemplateAddPlan } from "./types.js";

export function collectTemplateSkillWarningReviews(
  plan: TemplateAddPlan,
): Array<TemplateSkillWarning & { actionId: string }> {
  return plan.actions.flatMap<TemplateSkillWarning & { actionId: string }>((action) => {
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
    if (details.source === "bundled") {
      if (
        typeof details.path !== "string" ||
        typeof details.name !== "string" ||
        typeof action.digest !== "string"
      ) {
        throw new Error("The bundled skill trust review is incomplete.");
      }
      return [
        {
          actionId: action.id,
          source: "bundled" as const,
          path: details.path,
          name: details.name,
          digest: action.digest,
          riskWarning: details.riskWarning,
        },
      ];
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
