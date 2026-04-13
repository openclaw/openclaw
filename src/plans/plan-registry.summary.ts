import type { PlanRecord, PlanRegistrySummary, PlanStatusCounts } from "./plan-registry.types.js";

function createEmptyPlanStatusCounts(): PlanStatusCounts {
  return {
    draft: 0,
    ready_for_review: 0,
    approved: 0,
    rejected: 0,
    archived: 0,
  };
}

export function createEmptyPlanRegistrySummary(): PlanRegistrySummary {
  return {
    total: 0,
    reviewable: 0,
    terminal: 0,
    byStatus: createEmptyPlanStatusCounts(),
  };
}

export function summarizePlanRecords(records: Iterable<PlanRecord>): PlanRegistrySummary {
  const summary = createEmptyPlanRegistrySummary();
  for (const plan of records) {
    summary.total += 1;
    summary.byStatus[plan.status] += 1;
    if (plan.status === "draft" || plan.status === "ready_for_review") {
      summary.reviewable += 1;
    }
    if (plan.status === "approved" || plan.status === "rejected" || plan.status === "archived") {
      summary.terminal += 1;
    }
  }
  return summary;
}
