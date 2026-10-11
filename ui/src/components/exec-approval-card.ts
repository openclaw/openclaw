import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { formatApprovalDisplayPath } from "../../../src/infra/approval-display-paths.ts";
import { normalizeCommandSpans } from "../../../src/shared/exec-approval-command-spans.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { summarizeApprovalScopeLabel } from "../app/approval-presentation.ts";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../app/exec-approval.ts";
import { t } from "../i18n/index.ts";
import { formatCountdown } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { PollController } from "../lit/poll-controller.ts";

const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

type ExecApprovalCardProps = {
  approval: ExecApprovalRequest;
  sourceSession?: GatewaySessionRow;
  busy: boolean;
  canGrant: boolean;
  error: string | null;
  variant: "inline" | "modal";
  queueCount?: number;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
};

export type SidebarApprovalRowProps = {
  approval: ExecApprovalRequest;
  busy: boolean;
  canGrant: boolean;
  error: string | null;
  openSessionHref?: string;
  sessionTitle?: string | null;
  onDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
  onOpenSession?: (event: MouseEvent) => void;
};

export function approvalRemainingLabel(expiresAtMs: number, nowMs: number): string {
  return expiresAtMs > nowMs
    ? t("execApproval.expiresIn", { time: formatCountdown(expiresAtMs, nowMs, true) })
    : t("execApproval.expired");
}

class ApprovalCountdown extends OpenClawLightDomContentsElement {
  @property({ type: Number }) expiresAtMs = 0;
  @property({ type: Boolean }) compact = false;

  private readonly polling = new PollController(
    this,
    1_000,
    () => {
      this.requestUpdate();
      if (!this.compact) {
        this.closest("openclaw-modal-dialog")?.setAttribute(
          "description",
          approvalRemainingLabel(this.expiresAtMs, Date.now()),
        );
      }
    },
    false,
  );

  override connectedCallback() {
    super.connectedCallback();
    this.polling.start();
  }

  override render() {
    const nowMs = Date.now();
    return html`${
      this.compact
        ? formatCountdown(this.expiresAtMs, nowMs, true)
        : approvalRemainingLabel(this.expiresAtMs, nowMs)
    }`;
  }
}

if (!customElements.get("openclaw-approval-countdown")) {
  customElements.define("openclaw-approval-countdown", ApprovalCountdown);
}

function renderMetaRow(label: string, value?: string | null, opts?: { path?: boolean }) {
  if (!value) {
    return nothing;
  }
  return html`<div class="exec-approval-meta-row">
    <span>${label}</span><span>${opts?.path ? formatApprovalDisplayPath(value) : value}</span>
  </div>`;
}

function renderCommandWithSpans(request: ExecApprovalRequestPayload) {
  const spans =
    normalizeCommandSpans([...(request.commandSpans ?? [])], request.command.length) ?? [];
  const parts = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.startIndex > cursor) {
      parts.push(request.command.slice(cursor, span.startIndex));
    }
    parts.push(
      html`<mark class="exec-approval-command-span"
        >${request.command.slice(span.startIndex, span.endIndex)}</mark
      >`,
    );
    cursor = span.endIndex;
  }
  if (cursor < request.command.length) {
    parts.push(request.command.slice(cursor));
  }
  return html`<div class="exec-approval-command mono">${parts}</div>`;
}

function renderDetails(content: ReturnType<typeof html>) {
  return html`<details class="exec-approval-details">
    <summary>${t("execApproval.details")}</summary>
    <div class="exec-approval-meta">${content}</div>
  </details>`;
}

function renderChip(kind: "plugin" | "agent", id?: string | null) {
  return id
    ? html`<span class="exec-approval-chip mono" data-approval-chip=${kind}>${id}</span>`
    : nothing;
}

function renderExecBody(
  request: ExecApprovalRequestPayload,
  variant: ExecApprovalCardProps["variant"],
) {
  return html` ${renderCommandWithSpans(request)}
    ${
      request.scope
        ? html`<div class="exec-approval-scope">${summarizeApprovalScopeLabel(request.scope)}</div>`
        : nothing
    }
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.host"), request.host)}
      ${renderMetaRow(t("execApproval.labels.cwd"), request.cwd, { path: true })}
    </div>
    ${renderDetails(html`
      ${renderMetaRow(t("execApproval.labels.resolved"), request.resolvedPath, { path: true })}
      ${renderMetaRow(t("execApproval.labels.security"), request.security)}
      ${renderMetaRow(t("execApproval.labels.ask"), request.ask)}
      ${
        variant === "modal"
          ? renderMetaRow(t("execApproval.labels.session"), request.sessionKey)
          : nothing
      }
    `)}`;
}

function renderPluginBody(active: ExecApprovalRequest, variant: ExecApprovalCardProps["variant"]) {
  return html` ${
    active.pluginDescription
      ? html`<pre class="exec-approval-command mono">${active.pluginDescription}</pre>`
      : nothing
  }
  ${
    active.pluginDetail
      ? html`<pre class="exec-approval-command mono" dir="ltr">${active.pluginDetail}</pre>`
      : nothing
  }
  ${
    variant === "modal" && active.request.sessionKey
      ? renderDetails(
          html`${renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey)}`,
        )
      : nothing
  }`;
}

export function approvalDecisionLabel(
  decision: ExecApprovalDecision,
  approval: ExecApprovalRequest,
) {
  if (approval.kind === "plugin" && Array.isArray(approval.pluginActions)) {
    for (const action of approval.pluginActions) {
      if (isRecord(action) && action.kind === "decision" && action.decision === decision) {
        const label = normalizeOptionalString(action.label);
        if (label) {
          return label;
        }
      }
    }
  }
  return t(
    decision === "allow-once"
      ? "execApproval.allowOnce"
      : decision === "allow-always"
        ? approval.kind === "exec"
          ? "execApproval.alwaysAllowHere"
          : "execApproval.alwaysAllow"
        : "execApproval.deny",
  );
}

function decisionClass(decision: ExecApprovalDecision) {
  return decision === "allow-once" ? "btn primary" : decision === "deny" ? "btn danger" : "btn";
}

function decisionShortcut(decision: ExecApprovalDecision) {
  return decision === "allow-once"
    ? "Ctrl/Cmd+Enter"
    : decision === "allow-always"
      ? "Ctrl/Cmd+Shift+Enter"
      : "Ctrl/Cmd+D";
}

export function resolveApprovalDecisions(
  active: ExecApprovalRequest,
): readonly ExecApprovalDecision[] {
  if (active.request.allowedDecisions?.length) {
    return active.request.allowedDecisions;
  }
  return active.kind === "exec" && active.request.ask === "always"
    ? ["allow-once", "deny"]
    : DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function approvalTitle(active: ExecApprovalRequest): string {
  return active.kind !== "exec"
    ? (active.pluginTitle ?? t("execApproval.pluginApprovalNeeded"))
    : t("execApproval.execApprovalNeeded");
}

export function renderExecApprovalCard(props: ExecApprovalCardProps) {
  const active = props.approval;
  const decisions = resolveApprovalDecisions(active);
  const reviewOnlyMessage = t("execApproval.reviewOnly");
  const grantError = !props.canGrant && props.error === reviewOnlyMessage;
  const rawSeverity = active.pluginSeverity?.trim().toLowerCase();
  const severity =
    active.kind === "exec" || rawSeverity === "warning" || rawSeverity === "warn"
      ? "warning"
      : rawSeverity === "danger" || rawSeverity === "critical" || rawSeverity === "error"
        ? "danger"
        : "info";
  const pluginId = active.kind === "plugin" ? active.pluginId?.trim() : null;
  const agentId = props.variant === "modal" ? active.request.agentId?.trim() : null;
  return html` <div
    class="exec-approval-card exec-approval-card--${props.variant} exec-approval-card--severity-${severity}"
    data-approval-id=${active.id}
  >
    <div class="exec-approval-header">
      <div>
        <div class="exec-approval-title">${approvalTitle(active)}</div>
        ${
          pluginId || agentId
            ? html`<div class="exec-approval-chips">
                ${renderChip("plugin", pluginId)} ${renderChip("agent", agentId)}
              </div>`
            : nothing
        }
        <openclaw-approval-countdown
          class="exec-approval-sub exec-approval-countdown"
          role="timer"
          .expiresAtMs=${active.expiresAtMs}
        ></openclaw-approval-countdown>
      </div>
      ${
        (props.queueCount ?? 0) > 1
          ? html`<div class="exec-approval-queue">
              ${t("execApproval.pending", { count: String(props.queueCount) })}
            </div>`
          : nothing
      }
    </div>
    ${
      props.variant === "inline" && active.sourceSessionKey
        ? html`<div class="exec-approval-warning" role="note">
            ${t("execApproval.requestedBySession", {
              session: resolveSessionDisplayName(active.sourceSessionKey, props.sourceSession),
            })}
          </div>`
        : nothing
    }
    ${
      active.kind === "exec"
        ? renderExecBody(active.request, props.variant)
        : renderPluginBody(active, props.variant)
    }
    ${
      active.kind === "exec" && !decisions.includes("allow-always")
        ? html`<div class="exec-approval-warning">${t("execApproval.allowAlwaysUnavailable")}</div>`
        : nothing
    }
    ${
      !props.canGrant
        ? html`<div
            class=${grantError ? "exec-approval-error" : "exec-approval-warning"}
            role=${grantError ? "alert" : "note"}
          >
            ${reviewOnlyMessage}
          </div>`
        : nothing
    }
    ${
      props.error && !grantError
        ? html`<div class="exec-approval-error" role="alert">${props.error}</div>`
        : nothing
    }
    <div class="exec-approval-actions">
      ${decisions.map((decision) => {
        const label = approvalDecisionLabel(decision, active);
        return html`<button
          class=${decisionClass(decision)}
          type="button"
          aria-label=${label}
          ?disabled=${props.busy || !props.canGrant}
          title=${
            props.variant === "modal" && props.canGrant
              ? `${label} (${decisionShortcut(decision)})`
              : label
          }
          @click=${() => props.onDecision(active.id, decision)}
        >
          <span>${label}</span>
        </button>`;
      })}
    </div>
  </div>`;
}
