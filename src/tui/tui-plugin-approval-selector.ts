// Builds local TUI selector rows for pending plugin approvals.
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import {
  resolvePluginApprovalRequestAllowedDecisions,
  type PluginApprovalRequest,
} from "../infra/plugin-approvals.js";

export type TuiPluginApprovalSelectorItem = {
  value: string;
  label: string;
  description: string;
};

function approvalDecisionPromptLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "Allow once";
  }
  if (decision === "allow-always") {
    return "Allow always";
  }
  return "Deny";
}

function approvalDecisionPromptDescription(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "Approve this blocked action only";
  }
  if (decision === "allow-always") {
    return "Trust approvals for this session";
  }
  return "Reject this blocked action";
}

function isRunnableTuiCommand(command: string): boolean {
  return command.trim().startsWith("/");
}

export function buildPluginApprovalSelectorItems(
  request: PluginApprovalRequest,
): TuiPluginApprovalSelectorItem[] {
  const externalResolution = request.request.externalResolution ?? null;
  const externalDecisions = new Set<ExecApprovalDecision>();
  const items: TuiPluginApprovalSelectorItem[] = [];

  if (externalResolution) {
    for (const command of externalResolution.commands) {
      externalDecisions.add(command.decision);
      if (!isRunnableTuiCommand(command.command)) {
        continue;
      }
      items.push({
        value: command.command,
        label: command.label,
        description: command.description,
      });
    }
  }

  for (const decision of resolvePluginApprovalRequestAllowedDecisions(request.request)) {
    if (externalDecisions.has(decision)) {
      continue;
    }
    items.push({
      value: `/approve ${request.id} ${decision}`,
      label: approvalDecisionPromptLabel(decision),
      description: approvalDecisionPromptDescription(decision),
    });
  }

  return items;
}
