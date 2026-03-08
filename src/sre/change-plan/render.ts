import type { ChangePlan } from "../contracts/change-plan.js";

export function renderChangePlanMarkdown(plan: ChangePlan): string {
  const lines = [
    `# Change Plan ${plan.planId}`,
    "",
    `Incident: ${plan.incidentId}`,
    `Status: ${plan.status}`,
    `Summary: ${plan.summary}`,
  ];
  if (plan.rootCauseSummary) {
    lines.push(`Root cause: ${plan.rootCauseSummary}`);
  }
  lines.push("", "## Repos");
  for (const step of plan.steps) {
    lines.push(`- ${step.repoId}: ${step.summary}`);
    if (step.rationale) {
      lines.push(`  rationale: ${step.rationale}`);
    }
    if ((step.files?.length ?? 0) > 0) {
      lines.push(`  files: ${(step.files ?? []).join(", ")}`);
    }
    if ((step.validationCommands?.length ?? 0) > 0) {
      lines.push(`  validate: ${step.validationCommands.join(" ; ")}`);
    }
    if (step.rollback) {
      lines.push(`  rollback: ${step.rollback}`);
    }
    if ((step.dependsOn?.length ?? 0) > 0) {
      lines.push(`  dependsOn: ${(step.dependsOn ?? []).join(", ")}`);
    }
  }
  return `${lines.join("\n").trim()}\n`;
}
