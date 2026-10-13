import type { ApprovalPresentation } from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import { summarizeApprovalScopeLabel } from "../../app/approval-presentation.ts";
import { t } from "../../lib/reactive/i18n.ts";

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
