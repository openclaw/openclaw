import fs from "node:fs/promises";
import path from "node:path";
import { redactEnvValue, redactSecretText } from "./redaction.js";
import type { MigrationAction, MigrationApplyResult, MigrationPlan } from "./types.js";

export function redactMigrationAction(action: MigrationAction): MigrationAction {
  if (action.kind === "writeEnv") {
    return {
      ...action,
      value: redactEnvValue(action.key, action.value),
    };
  }
  if (action.kind === "mergeConfig") {
    return JSON.parse(redactSecretText(JSON.stringify(action))) as MigrationAction;
  }
  return action;
}

export function redactMigrationPlan(plan: MigrationPlan): MigrationPlan {
  return {
    ...plan,
    actions: plan.actions.map(redactMigrationAction),
  };
}

export function summarizeMigrationPlan(plan: MigrationPlan): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const action of plan.actions) {
    summary[action.category] = (summary[action.category] ?? 0) + 1;
  }
  return summary;
}

export function formatMigrationPlanText(plan: MigrationPlan): string {
  const summary = summarizeMigrationPlan(plan);
  const lines = [
    `${plan.label} migration plan`,
    `Source: ${plan.sourceDir}`,
    `Target state: ${plan.targetStateDir}`,
    `Target workspace: ${plan.targetWorkspaceDir}`,
    `Actions: ${plan.actions.length}`,
    "",
    "Categories:",
    ...Object.entries(summary).map(([category, count]) => `- ${category}: ${count}`),
  ];
  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:", ...plan.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

export async function writeMigrationReport(result: MigrationApplyResult): Promise<void> {
  await fs.mkdir(result.reportDir, { recursive: true });
  const lines = [
    `# Migration Report`,
    "",
    `Plan: ${result.planId}`,
    `Dry run: ${result.dryRun ? "yes" : "no"}`,
    "",
    "| Status | Kind | Category | Reason |",
    "| --- | --- | --- | --- |",
    ...result.results.map(
      (entry) =>
        `| ${entry.status} | ${entry.kind} | ${entry.category} | ${entry.reason.replaceAll("|", "\\|")} |`,
    ),
    "",
  ];
  await fs.writeFile(path.join(result.reportDir, "report.md"), lines.join("\n"), "utf-8");
}
