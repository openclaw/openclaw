import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ApprovalScope } from "../../../src/infra/approval-scope.ts";
import { t } from "../i18n/index.ts";

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

export function compactApprovalCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 64 ? `${truncateUtf16Safe(singleLine, 61)}…` : singleLine;
}
