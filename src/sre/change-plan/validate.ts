import type { OpenClawConfig } from "../../config/config.js";
import { loadRepoOwnershipForRuntime, matchRepoOwnershipPath } from "../../plugins/path-safety.js";
import type { ChangePlan } from "../contracts/change-plan.js";
import { logSreMetric } from "../observability/log.js";

export type ValidatedChangePlan = ChangePlan;

type ValidateChangePlanOptions = {
  config?: OpenClawConfig;
};

export async function validateChangePlan(
  plan: ChangePlan,
  options?: ValidateChangePlanOptions,
): Promise<ValidatedChangePlan> {
  if (!plan.incidentId.trim()) {
    logSreMetric("change_plan_validation_failed", { reason: "missing_incident_id" });
    throw new Error("change plan requires incidentId");
  }
  if (!plan.summary.trim()) {
    logSreMetric("change_plan_validation_failed", {
      reason: "missing_summary",
      incidentId: plan.incidentId,
    });
    throw new Error("change plan requires summary");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    logSreMetric("change_plan_validation_failed", {
      reason: "missing_steps",
      incidentId: plan.incidentId,
    });
    throw new Error("change plan requires at least one step");
  }

  const ownership = await loadRepoOwnershipForRuntime({ config: options?.config });
  const allowedRepoIds = new Set(ownership.repos.map((repo) => repo.repoId));

  for (const step of plan.steps) {
    if (!allowedRepoIds.has(step.repoId)) {
      logSreMetric("change_plan_wrong_repo_rejection", {
        incidentId: plan.incidentId,
        repoId: step.repoId,
      });
      throw new Error(`change plan references unknown repo: ${step.repoId}`);
    }
    const repo = ownership.repos.find((entry) => entry.repoId === step.repoId);
    if (!repo) {
      throw new Error(`repo ownership missing for ${step.repoId}`);
    }
    for (const file of step.files ?? []) {
      const resolved = new URL(`file://${repo.resolvedLocalPath.replace(/\\/g, "/")}/${file}`)
        .pathname;
      const match = matchRepoOwnershipPath(resolved, ownership);
      if (!match || match.repo.repoId !== step.repoId || !match.owned) {
        logSreMetric("change_plan_validation_failed", {
          reason: "outside_owned_paths",
          incidentId: plan.incidentId,
          repoId: step.repoId,
          file,
        });
        throw new Error(`change plan file is outside owned paths: ${step.repoId}:${file}`);
      }
    }
    for (const dependency of step.dependsOn ?? []) {
      if (!allowedRepoIds.has(dependency)) {
        logSreMetric("change_plan_validation_failed", {
          reason: "unknown_dependency",
          incidentId: plan.incidentId,
          repoId: step.repoId,
          dependency,
        });
        throw new Error(`change plan dependency references unknown repo: ${dependency}`);
      }
    }
  }

  logSreMetric("change_plan_validation_passed", {
    incidentId: plan.incidentId,
    repoCount: plan.steps.length,
  });
  return plan;
}
