import type { InteractiveReplyButton } from "../interactive/payload.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";

type ApprovalActionStyle = NonNullable<InteractiveReplyButton["style"]>;

export type ApprovalDecisionActionView = {
  kind?: "decision";
  decision: ExecApprovalDecision;
  label: string;
  style: ApprovalActionStyle;
  command: string;
};

export type ApprovalCommandActionView = {
  kind: "command";
  decision?: never;
  label: string;
  style: ApprovalActionStyle;
  command: string;
};

export type ApprovalActionView = ApprovalDecisionActionView | ApprovalCommandActionView;

export function isApprovalDecisionActionView(
  action: ApprovalActionView,
): action is ApprovalDecisionActionView {
  return typeof action.decision === "string";
}

export function listApprovalDecisionActions(
  actions: readonly ApprovalActionView[],
): ApprovalDecisionActionView[] {
  return actions.filter(isApprovalDecisionActionView);
}
