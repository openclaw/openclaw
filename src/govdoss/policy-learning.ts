import { buildGovdossForensicsReport } from "./replay-engine.js";

export type GovdossPolicySignal = {
  tenantId?: string;
  action: string;
  signal: "raise-risk" | "lower-risk" | "require-approval" | "allow-bounded";
  confidence: number;
  rationale: string;
  observedCount: number;
};

export type GovdossPolicyLearningReport = {
  tenantId?: string;
  generatedAt: number;
  signals: GovdossPolicySignal[];
  summary: {
    totalSignals: number;
    highRiskActions: string[];
    approvalHeavyActions: string[];
    stableActions: string[];
  };
};

function topKeys(input: Record<string, number>, min = 1): string[] {
  return Object.entries(input)
    .filter(([, value]) => value >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
}

export function buildGovdossPolicyLearningReport(input: {
  tenantId?: string;
  limit?: number;
}): GovdossPolicyLearningReport {
  const report = buildGovdossForensicsReport(input);
  const signals: GovdossPolicySignal[] = [];

  const approvalHeavyActions = new Set<string>();
  const highRiskActions = new Set<string>();
  const stableActions = new Set<string>();

  const actionCounts = report.actions;
  const resultCounts = report.results;
  const approvalEvents = resultCounts["approval-required"] ?? 0;
  const completedEvents = resultCounts["completed"] ?? 0;

  for (const [action, observedCount] of Object.entries(actionCounts)) {
    const timeline = report.timeline.filter((frame) => frame.action === action);
    const actionApprovalCount = timeline.filter((frame) => frame.result === "approval-required").length;
    const actionCompletedCount = timeline.filter((frame) => frame.result === "completed").length;
    const approvalRatio = observedCount === 0 ? 0 : actionApprovalCount / observedCount;
    const completionRatio = observedCount === 0 ? 0 : actionCompletedCount / observedCount;

    if (approvalRatio >= 0.4) {
      approvalHeavyActions.add(action);
      signals.push({
        tenantId: input.tenantId,
        action,
        signal: "require-approval",
        confidence: Math.min(0.95, 0.55 + approvalRatio / 2),
        rationale: "action frequently enters approval-required path",
        observedCount,
      });
    }

    if (approvalRatio >= 0.6 || action.includes("config") || action.includes("secrets") || action.includes("node.")) {
      highRiskActions.add(action);
      signals.push({
        tenantId: input.tenantId,
        action,
        signal: "raise-risk",
        confidence: Math.min(0.98, 0.6 + approvalRatio / 3),
        rationale: "action shows elevated governance friction or sensitive surface",
        observedCount,
      });
    }

    if (observedCount >= 5 && approvalRatio === 0 && completionRatio >= 0.8) {
      stableActions.add(action);
      signals.push({
        tenantId: input.tenantId,
        action,
        signal: "allow-bounded",
        confidence: Math.min(0.9, 0.5 + completionRatio / 3),
        rationale: "action repeatedly completes without approval interruption",
        observedCount,
      });
      signals.push({
        tenantId: input.tenantId,
        action,
        signal: "lower-risk",
        confidence: Math.min(0.85, 0.45 + completionRatio / 4),
        rationale: "historical execution indicates stable bounded behavior",
        observedCount,
      });
    }
  }

  if (approvalEvents > completedEvents && approvalEvents > 0) {
    for (const action of topKeys(actionCounts, 2).slice(0, 3)) {
      if (!approvalHeavyActions.has(action)) {
        signals.push({
          tenantId: input.tenantId,
          action,
          signal: "require-approval",
          confidence: 0.51,
          rationale: "tenant-level activity shows more approval holds than completed actions",
          observedCount: actionCounts[action] ?? 0,
        });
      }
    }
  }

  return {
    tenantId: input.tenantId,
    generatedAt: Date.now(),
    signals,
    summary: {
      totalSignals: signals.length,
      highRiskActions: [...highRiskActions],
      approvalHeavyActions: [...approvalHeavyActions],
      stableActions: [...stableActions],
    },
  };
}
