import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ApprovalScope } from "../../../src/infra/approval-scope.ts";
import { t } from "../i18n/index.ts";
import {
  formatKeyboardShortcutParts,
  isApplePlatform,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import type { ExecApprovalDecision } from "./exec-approval.ts";

export function summarizeApprovalScopeLabel(scope: ApprovalScope): string {
  switch (scope.kind) {
    case "standing-grant":
      return scope.expiresInDays !== undefined
        ? t("execApproval.scope.standingGrantDays", {
            automation: scope.automation,
            count: String(scope.expiresInDays),
          })
        : t("execApproval.scope.standingGrant", { automation: scope.automation });
    case "message-send":
      return t("execApproval.scope.messageSend", {
        count: String(scope.recipientCount),
        target: scope.target,
      });
    case "payment":
      return t("execApproval.scope.payment", {
        amount: scope.amount,
        currency: scope.currency,
        target: scope.target,
      });
    case "external-post":
      return t("execApproval.scope.externalPost", { target: scope.target });
  }
  return scope satisfies never;
}

export function approvalHostLabel(host: string | null | undefined): string | undefined {
  switch (host) {
    case "gateway":
      return t("execApproval.labels.thisComputer");
    case "node":
      return t("execApproval.labels.node");
    case "sandbox":
      return t("execApproval.labels.sandbox");
    default:
      return host ?? undefined;
  }
}

export function compactApprovalCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 64 ? `${truncateUtf16Safe(singleLine, 61)}…` : singleLine;
}

export function formatApprovalDecisionShortcut(decision: ExecApprovalDecision) {
  if (!isApplePlatform()) {
    const combo =
      decision === "allow-once"
        ? KEYBOARD_SHORTCUT_COMBOS.modifiedEnter
        : decision === "allow-always"
          ? KEYBOARD_SHORTCUT_COMBOS.approveAlways
          : KEYBOARD_SHORTCUT_COMBOS.denyApproval;
    return formatKeyboardShortcutParts(combo, false).join("");
  }
  return decision === "allow-once"
    ? "Ctrl/Cmd+Enter"
    : decision === "allow-always"
      ? "Ctrl/Cmd+Shift+Enter"
      : "Ctrl/Cmd+D";
}
