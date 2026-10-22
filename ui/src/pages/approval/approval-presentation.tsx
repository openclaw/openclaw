import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type {
  ApprovalDecision,
  ApprovalPresentation,
  ApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import { summarizeApprovalScopeLabel } from "../../app/approval-presentation.ts";
import { registerApprovalsEnglish } from "../../i18n/locales/en-approvals.ts";
import { formatDateTimeMs } from "../../lib/reactive/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerApprovalsEnglish);

export type ResolutionOrigin = "here" | "elsewhere" | "observed";

type ApprovalPageView = {
  read: () => {
    resolutionOrigin: ResolutionOrigin;
    requestError: "connection" | "unavailable" | null;
  };
  setHeading: (element: HTMLHeadingElement) => void;
  hasApprovalGrantAccess: () => boolean;
  hasGatewayConnection: () => boolean;
  resolvingDecision: () => ApprovalDecision | null;
  resolveApproval: (decision: ApprovalDecision) => Promise<void>;
};

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

function ApprovalChip(props: { kind: "plugin" | "tool" | "agent"; value?: string | null }) {
  return (
    <Show when={props.value?.trim()}>
      {(value) => (
        <span class="approval-page__chip mono" data-approval-chip={props.kind}>
          {value()}
        </span>
      )}
    </Show>
  );
}

export function ApprovalContent(props: {
  approval: ApprovalSnapshot;
  page: ApprovalPageView;
  retry: (className: string) => JSX.Element;
}) {
  const pending = () => props.approval.status === "pending";
  const presentation = () => props.approval.presentation;
  const origin = () => props.page.read().resolutionOrigin;
  const pluginPresentation = () => {
    const value = presentation();
    return value.kind === "plugin" ? value : null;
  };
  const resolvedAt = () => {
    const approval = props.approval;
    return approval.status === "pending" ? approval.expiresAtMs : approval.resolvedAtMs;
  };
  return (
    <>
      <div class="approval-page__status" aria-live="polite" aria-atomic="true">
        <span
          class={[
            "approval-page__status-dot",
            `approval-page__status-dot--${props.approval.status}`,
          ]}
          aria-hidden="true"
        />
        {pending() ? t("approvalPage.pending") : terminalTitle(props.approval, origin())}
      </div>
      <div class="approval-page__heading">
        <h1
          ref={props.page.setHeading}
          id="approval-page-title"
          tabindex={pending() ? undefined : -1}
        >
          {approvalTitle(props.approval, origin())}
        </h1>
        <div class="approval-page__chips">
          <Show when={pluginPresentation()}>
            {(value) => (
              <>
                <ApprovalChip kind="plugin" value={value().pluginId} />
                <ApprovalChip kind="tool" value={value().toolName} />
              </>
            )}
          </Show>
          <ApprovalChip kind="agent" value={presentation().agentId} />
        </div>
        <p>
          {pending()
            ? t(
                props.page.hasApprovalGrantAccess()
                  ? "approvalPage.pendingDescription"
                  : "execApproval.reviewOnly",
              )
            : terminalDescription(props.approval, origin())}
        </p>
      </div>
      {renderApprovalPresentation(presentation())}
      <div class="approval-page__timing">
        <span>{pending() ? t("approvalPage.expiresLabel") : t("approvalPage.resolvedLabel")}</span>
        <time datetime={new Date(resolvedAt()).toISOString()}>
          {formatDateTimeMs(resolvedAt(), { dateStyle: "medium", timeStyle: "short" })}
        </time>
      </div>
      <Show when={props.page.read().requestError === "connection"}>
        <div class="approval-page__callout" role="alert">
          <div>
            <strong>{t("approvalPage.connectionErrorTitle")}</strong>
            <span>{t("approvalPage.connectionErrorDescription")}</span>
          </div>
          {props.retry("btn btn--sm")}
        </div>
      </Show>
      <Show
        when={pending()}
        fallback={
          <div class="approval-page__terminal" role="status">
            {t("approvalPage.safeToClose")}
          </div>
        }
      >
        <div
          class="approval-page__actions"
          role="group"
          aria-label={t("approvalPage.actionsLabel")}
        >
          <For each={presentation().allowedDecisions} keyed={(decision) => decision}>
            {(decision) => (
              <button
                type="button"
                class={["btn approval-page__action", `approval-page__action--${decision()}`]}
                data-decision={decision()}
                disabled={
                  props.page.resolvingDecision() !== null ||
                  !props.page.hasGatewayConnection() ||
                  !props.page.hasApprovalGrantAccess() ||
                  props.page.read().requestError !== null
                }
                onClick={() => void props.page.resolveApproval(decision())}
              >
                {props.page.resolvingDecision() === decision()
                  ? t("approvalPage.resolvingDecision", {
                      decision: decisionLabel(decision(), presentation()),
                    })
                  : decisionLabel(decision(), presentation())}
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
