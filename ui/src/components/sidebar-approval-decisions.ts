import type { ExecApprovalDecision } from "../app/exec-approval.ts";
import { t } from "../lib/reactive/i18n.ts";

const ORDER: readonly ExecApprovalDecision[] = ["allow-once", "allow-always", "deny"];

/** The Inbox always reads permit first, whatever order the request lists. */
export function inboxDecisionOrder(decisions: readonly ExecApprovalDecision[]) {
  return decisions.toSorted((left, right) => ORDER.indexOf(left) - ORDER.indexOf(right));
}

/** Plugin and time-limited grant labels stay as the request words them. */
export function inboxDecisionLabel(label: string) {
  return label === t("execApproval.alwaysAllow") ? t("execApproval.alwaysAllowHere") : label;
}
