// Pure plan-checklist types + extraction — no i18n/lit dependency, so node-side modules
// (e.g. the chat tool-stream) can import it without pulling in browser rendering deps.

export type PlanChecklistStepStatus = "pending" | "in_progress" | "completed";

export type PlanChecklistStep = {
  step: string;
  status: PlanChecklistStepStatus;
};

/** Live plan checklist derived from the latest stream:plan (update_plan) event. */
export type PlanChecklist = {
  explanation?: string;
  steps: PlanChecklistStep[];
};

const PLAN_STEP_STATUSES = new Set<PlanChecklistStepStatus>([
  "pending",
  "in_progress",
  "completed",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Extracts a plan checklist from a live update_plan tool result (`{ details: { plan, explanation } }`),
 * as delivered on the stream:plan / tool agent-event path. Returns null when the payload is not a
 * recognizable plan update, so callers can ignore unrelated tool events.
 */
export function extractPlanChecklist(result: unknown): PlanChecklist | null {
  const details = asRecord(asRecord(result)?.details);
  const rawPlan = details?.plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    return null;
  }
  const steps: PlanChecklistStep[] = [];
  for (const entry of rawPlan) {
    const record = asRecord(entry);
    const step = typeof record?.step === "string" ? record.step : null;
    const status = record?.status;
    if (!step || !PLAN_STEP_STATUSES.has(status as PlanChecklistStepStatus)) {
      return null;
    }
    steps.push({ step, status: status as PlanChecklistStepStatus });
  }
  const explanation = typeof details?.explanation === "string" ? details.explanation : undefined;
  return { steps, ...(explanation ? { explanation } : {}) };
}
