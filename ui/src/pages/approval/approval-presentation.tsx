import type {
  ApprovalDecision,
  ApprovalPresentation,
  ApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import { summarizeApprovalScopeLabel } from "../../app/approval-presentation.ts";
import { t } from "../../lib/reactive/i18n.ts";

export type ResolutionOrigin = "here" | "elsewhere" | "observed";

export function decisionLabel(
  decision: ApprovalDecision,
  presentation: ApprovalPresentation,
): string {
  const proposal = presentation.kind === "exec" ? presentation.streamProposal : undefined;
  if (proposal && decision !== "allow-always") {
    return t(
      decision === "deny"
        ? "execApproval.cancelWatcher"
        : proposal.operation === "add"
          ? "execApproval.startWatcher"
          : "execApproval.saveWatcher",
    );
  }
  return t(
    {
      "allow-once": "execApproval.allowOnce",
      "allow-always": "execApproval.alwaysAllow",
      deny: "execApproval.deny",
    }[decision],
  );
}

export function terminalTitle(approval: ApprovalSnapshot, origin: ResolutionOrigin): string {
  if (origin === "elsewhere" && (approval.status === "allowed" || approval.status === "denied")) {
    return t("approvalPage.resolvedElsewhere");
  }
  if (origin === "here" && approval.status === "allowed") {
    return t("approvalPage.approvedHere");
  }
  if (origin === "here" && approval.status === "denied") {
    return t("approvalPage.deniedHere");
  }
  return t(
    {
      allowed: "approvalPage.approved",
      denied: "approvalPage.denied",
      expired: "approvalPage.expired",
      cancelled: "approvalPage.cancelled",
      pending: "approvalPage.pending",
    }[approval.status],
  );
}

export function terminalDescription(approval: ApprovalSnapshot, origin: ResolutionOrigin): string {
  if (approval.presentation.kind === "exec" && approval.presentation.streamProposal) {
    const outcome = t(
      approval.status === "allowed"
        ? "approvalPage.watcherAllowed"
        : approval.presentation.streamProposal.operation === "add"
          ? "approvalPage.watcherNotCreated"
          : "approvalPage.watcherNotChanged",
    );
    return origin === "elsewhere" && (approval.status === "allowed" || approval.status === "denied")
      ? `${t("approvalPage.resolvedElsewhereDescription")} ${outcome}`
      : outcome;
  }
  if (origin === "elsewhere" && (approval.status === "allowed" || approval.status === "denied")) {
    return t("approvalPage.resolvedElsewhereDescription");
  }
  if (approval.status === "allowed") {
    return t(
      approval.decision === "allow-always"
        ? "approvalPage.allowedAlwaysDescription"
        : "approvalPage.allowedOnceDescription",
    );
  }
  return t(
    {
      denied: "approvalPage.deniedDescription",
      expired: "approvalPage.expiredDescription",
      cancelled: "approvalPage.cancelledDescription",
      pending: "approvalPage.pendingDescription",
    }[approval.status],
  );
}

export function approvalTitle(approval: ApprovalSnapshot, origin: ResolutionOrigin): string {
  if (
    approval.status === "pending" &&
    approval.presentation.kind === "exec" &&
    approval.presentation.streamProposal
  ) {
    const proposal = approval.presentation.streamProposal;
    return t(
      proposal.operation === "add"
        ? "approvalPage.watcherTitle"
        : "approvalPage.watcherChangeTitle",
      { name: proposal.name },
    );
  }
  return approval.status === "pending"
    ? approval.presentation.kind === "plugin"
      ? approval.presentation.title
      : t("approvalPage.execTitle")
    : terminalTitle(approval, origin);
}

function renderMetaRow(label: string, value?: string | null) {
  return value ? (
    <div class="approval-page__meta-row">
      <dt>{label}</dt>
      <dd title={value}>
        <bdi dir="ltr">{value}</bdi>
      </dd>
    </div>
  ) : null;
}

export function renderApprovalPresentation(presentation: ApprovalPresentation) {
  const scopeLabel =
    presentation.kind !== "system-agent" && presentation.scope
      ? summarizeApprovalScopeLabel(presentation.scope)
      : null;
  const scope = scopeLabel ? (
    <div class="approval-page__warning" role="note">
      {scopeLabel}
    </div>
  ) : null;
  if (presentation.kind === "exec") {
    return (
      <>
        {scope}
        {presentation.streamProposal ? (
          <p>
            {t("approvalPage.watcherLifetime")} {t("execApproval.watcherApprovalScope")}
          </p>
        ) : null}
        {presentation.warningText ? (
          <div class="approval-page__warning" role="note">
            {presentation.warningText}
          </div>
        ) : null}
        {presentation.commandPreview ? (
          <>
            <div class="approval-page__preview-label">{t("approvalPage.summaryLabel")}</div>
            <div class="approval-page__summary mono" dir="ltr">
              {presentation.commandPreview}
            </div>
          </>
        ) : null}
        <div class="approval-page__preview-label">{t("approvalPage.commandLabel")}</div>
        <pre class="approval-page__preview mono" dir="ltr">
          {presentation.commandText}
        </pre>
        <dl class="approval-page__meta">
          {renderMetaRow(t("execApproval.labels.host"), presentation.host)}
          {renderMetaRow(t("approvalPage.nodeLabel"), presentation.nodeId)}
        </dl>
      </>
    );
  }
  return (
    <>
      {scope}
      <div class="approval-page__preview-label">{t("approvalPage.requestLabel")}</div>
      <div class="approval-page__preview approval-page__preview--prose">
        {presentation.description}
      </div>
      {presentation.kind === "plugin" && presentation.detail ? (
        <pre class="approval-page__preview mono" dir="ltr">
          {presentation.detail}
        </pre>
      ) : null}
    </>
  );
}
