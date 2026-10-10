import { createMemo, For } from "solid-js";
import {
  compactApprovalCommand,
  summarizeApprovalScopeLabel,
} from "../../app/approval-presentation.ts";
import { t } from "../../i18n/index.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  approvalRemainingLabel,
  approvalDecisionLabel,
  approvalTitle,
  resolveApprovalDecisions,
  type SidebarApprovalRowProps,
} from "../exec-approval-card.ts";
import { Icon } from "./icon.tsx";

export function renderSidebarApprovalRow(props: SidebarApprovalRowProps) {
  const expired = () => props.approval.expiresAtMs <= Date.now();
  const command = createMemo(() => compactApprovalCommand(props.approval.request.command));
  const sessionTitle = createMemo(() => {
    const sessionKey = props.approval.request.sessionKey?.trim();
    return (
      props.sessionTitle ??
      (sessionKey ? resolveSessionDisplayName(sessionKey) : approvalTitle(props.approval))
    );
  });
  const expiryLabel = () => approvalRemainingLabel(props.approval.expiresAtMs, Date.now());
  const reviewOnlyMessage = () => t("execApproval.reviewOnly");
  const grantError = () => !props.canGrant && props.error === reviewOnlyMessage();
  return (
    <article
      class="sidebar-approval-row sidebar-issues-panel__details--warning"
      data-attention-kind="pendingApproval"
      data-approval-id={props.approval.id}
    >
      <span class="sidebar-issues-panel__icon sidebar-approval-row__icon" aria-hidden="true">
        <Icon name="shieldQuestion" />
      </span>
      <div class="sidebar-approval-row__content">
        <div class="sidebar-approval-row__header" data-issue-row-focus tabindex="-1">
          <span class="sidebar-issues-panel__entity" title={sessionTitle()}>
            {sessionTitle()}
          </span>
          <openclaw-approval-countdown
            class={[
              "sidebar-approval-row__timer",
              {
                "sidebar-approval-row__timer--urgent":
                  expired() || props.approval.expiresAtMs - Date.now() < 2 * 60_000,
              },
            ]}
            role="timer"
            aria-label={expiryLabel()}
            title={expiryLabel()}
            prop:expiresAtMs={props.approval.expiresAtMs}
            prop:compact={true}
          />
        </div>
        <div class="sidebar-approval-row__command mono" title={props.approval.request.command}>
          <span aria-hidden="true">$ </span>
          {command()}
        </div>
        {props.approval.request.scope ? (
          <div class="exec-approval-scope">
            {summarizeApprovalScopeLabel(props.approval.request.scope)}
          </div>
        ) : null}
        <div
          class="sidebar-approval-row__actions"
          role="group"
          aria-label={t("approvalPage.actionsLabel")}
        >
          <For each={resolveApprovalDecisions(props.approval)}>
            {(decision) => {
              const label = () => approvalDecisionLabel(decision, props.approval);
              return (
                <button
                  type="button"
                  class={[
                    "btn btn--xs sidebar-approval-row__action",
                    `sidebar-approval-row__action--${decision}`,
                    { "btn--ghost": decision === "deny" },
                  ]}
                  aria-label={t("execApproval.decisionRequest", {
                    decision: label(),
                    command: command(),
                  })}
                  disabled={props.busy || !props.canGrant || expired()}
                  onClick={(event: Event) => props.onDecision(event, props.approval.id, decision)}
                >
                  {label()}
                </button>
              );
            }}
          </For>
          {props.openSessionHref && props.onOpenSession ? (
            <a
              class="sidebar-approval-row__open-session"
              href={props.openSessionHref}
              aria-label={t("sessionsView.openSession")}
              title={t("sessionsView.openSession")}
              onClick={(event) => props.onOpenSession?.(event)}
            >
              <Icon name="arrowUpRight" />
            </a>
          ) : null}
        </div>
        {!props.canGrant ? (
          <div class="sidebar-approval-row__message" role={grantError() ? "alert" : "note"}>
            {reviewOnlyMessage()}
          </div>
        ) : null}
        {props.error && !grantError() ? (
          <div
            class="sidebar-approval-row__message sidebar-approval-row__message--error"
            role="alert"
          >
            {props.error}
          </div>
        ) : null}
      </div>
    </article>
  );
}
