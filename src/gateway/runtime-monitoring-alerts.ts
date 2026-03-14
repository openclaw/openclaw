import type { FormalRuntimeIssue, FormalRuntimeMonitoringSummary } from "./runtime-monitoring.js";

export type FormalRuntimeIssueTransition = "opened" | "resolved";

export type FormalRuntimeIssueAlert = {
  transition: FormalRuntimeIssueTransition;
  issue: FormalRuntimeIssue;
  text: string;
};

function formatAlertText(
  transition: FormalRuntimeIssueTransition,
  issue: FormalRuntimeIssue,
): string {
  const prefix =
    transition === "opened" ? "Formal runtime issue opened" : "Formal runtime issue resolved";
  return `${prefix}: [${issue.priority}] ${issue.code} - ${issue.summary}`;
}

export function diffFormalRuntimeMonitoringIssues(
  previous: FormalRuntimeMonitoringSummary | undefined,
  next: FormalRuntimeMonitoringSummary,
): FormalRuntimeIssueAlert[] {
  const previousIssues = new Map((previous?.issues ?? []).map((issue) => [issue.code, issue]));
  const nextIssues = new Map(next.issues.map((issue) => [issue.code, issue]));
  const alerts: FormalRuntimeIssueAlert[] = [];

  for (const issue of next.issues) {
    if (previousIssues.has(issue.code)) {
      continue;
    }
    alerts.push({
      transition: "opened",
      issue,
      text: formatAlertText("opened", issue),
    });
  }

  for (const issue of previous?.issues ?? []) {
    if (nextIssues.has(issue.code)) {
      continue;
    }
    alerts.push({
      transition: "resolved",
      issue,
      text: formatAlertText("resolved", issue),
    });
  }

  return alerts;
}
