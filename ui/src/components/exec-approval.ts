// Control UI component renders exec approval surfaces.
import { html, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { formatApprovalDisplayPath } from "../../../src/infra/approval-display-paths.ts";
import { modalApprovalQueue } from "../app/approval-presentation.ts";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../app/exec-approval.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import type { OpenClawModalDialog } from "./modal-dialog.ts";
import "./modal-dialog.ts";

const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

const APPROVAL_DECISION_CLASSES: Record<ExecApprovalDecision, string> = {
  "allow-once": "btn primary",
  "allow-always": "btn",
  deny: "btn danger",
};

const APPROVAL_DECISION_SHORTCUTS: Record<ExecApprovalDecision, string> = {
  "allow-once": "Ctrl/Cmd+Enter",
  "allow-always": "Ctrl/Cmd+Shift+Enter",
  deny: "Ctrl/Cmd+D",
};

type ExecApprovalProps = {
  queue: readonly ExecApprovalRequest[];
  busy: boolean;
  errors: ReadonlyMap<string, string>;
  nowMs: number;
  inlineApprovalId?: string | null;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
};

export type ExecApprovalCardProps = {
  approval: ExecApprovalRequest;
  busy: boolean;
  error: string | null;
  nowMs: number;
  variant: "inline" | "modal";
  queueCount?: number;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
};

export function formatApprovalCountdown(expiresAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function approvalRemainingLabel(expiresAtMs: number, nowMs: number): string {
  return expiresAtMs > nowMs
    ? t("execApproval.expiresIn", { time: formatApprovalCountdown(expiresAtMs, nowMs) })
    : t("execApproval.expired");
}

function renderMetaRow(label: string, value?: string | null, opts?: { path?: boolean }) {
  if (!value) {
    return nothing;
  }
  const displayValue = opts?.path ? formatApprovalDisplayPath(value) : value;
  return html`<div class="exec-approval-meta-row">
    <span>${label}</span><span>${displayValue}</span>
  </div>`;
}

function renderCommandWithSpans(request: ExecApprovalRequestPayload) {
  const commandSpans = [...(request.commandSpans ?? [])]
    .filter(
      (span) =>
        Number.isSafeInteger(span.startIndex) &&
        Number.isSafeInteger(span.endIndex) &&
        span.startIndex >= 0 &&
        span.endIndex > span.startIndex &&
        span.endIndex <= request.command.length,
    )
    .toSorted((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const accepted: typeof commandSpans = [];
  let cursor = 0;
  for (const span of commandSpans) {
    if (span.startIndex < cursor) {
      continue;
    }
    accepted.push(span);
    cursor = span.endIndex;
  }
  if (accepted.length === 0) {
    return html`<div class="exec-approval-command mono">${request.command}</div>`;
  }
  const parts = [];
  cursor = 0;
  for (const span of accepted) {
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

function renderExecBody(request: ExecApprovalRequestPayload) {
  return html`
    ${renderCommandWithSpans(request)}
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.host"), request.host)}
      ${renderMetaRow(t("execApproval.labels.agent"), request.agentId)}
      ${renderMetaRow(t("execApproval.labels.session"), request.sessionKey)}
      ${renderMetaRow(t("execApproval.labels.cwd"), request.cwd, { path: true })}
      ${renderMetaRow(t("execApproval.labels.resolved"), request.resolvedPath, { path: true })}
      ${renderMetaRow(t("execApproval.labels.security"), request.security)}
      ${renderMetaRow(t("execApproval.labels.ask"), request.ask)}
    </div>
  `;
}

function renderPluginBody(active: ExecApprovalRequest) {
  return html`
    ${active.pluginDescription
      ? html`<pre class="exec-approval-command mono" style="white-space:pre-wrap">
${active.pluginDescription}</pre>`
      : nothing}
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.severity"), active.pluginSeverity)}
      ${renderMetaRow(t("execApproval.labels.plugin"), active.pluginId)}
      ${renderMetaRow(t("execApproval.labels.agent"), active.request.agentId)}
      ${renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey)}
    </div>
  `;
}

function approvalDecisionLabel(decision: ExecApprovalDecision): string {
  const labels: Record<ExecApprovalDecision, string> = {
    "allow-once": t("execApproval.allowOnce"),
    "allow-always": t("execApproval.alwaysAllow"),
    deny: t("execApproval.deny"),
  };
  return labels[decision];
}

function approvalDecisionClass(decision: ExecApprovalDecision): string {
  return APPROVAL_DECISION_CLASSES[decision];
}

function approvalDecisionShortcut(decision: ExecApprovalDecision): string {
  return APPROVAL_DECISION_SHORTCUTS[decision];
}

export function resolveApprovalDecisions(
  active: ExecApprovalRequest,
): readonly ExecApprovalDecision[] {
  if (active.request.allowedDecisions?.length) {
    return active.request.allowedDecisions;
  }
  if (active.kind === "exec" && active.request.ask === "always") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_EXEC_APPROVAL_DECISIONS;
}

function renderUnavailableDecisionWarning(
  active: ExecApprovalRequest,
  decisions: readonly ExecApprovalDecision[],
) {
  return active.kind !== "exec" || decisions.includes("allow-always")
    ? nothing
    : html`<div class="exec-approval-warning">${t("execApproval.allowAlwaysUnavailable")}</div>`;
}

function approvalTitle(active: ExecApprovalRequest): string {
  return active.kind !== "exec"
    ? (active.pluginTitle ?? t("execApproval.pluginApprovalNeeded"))
    : t("execApproval.execApprovalNeeded");
}

export function renderExecApprovalCard(props: ExecApprovalCardProps) {
  const active = props.approval;
  const decisions = resolveApprovalDecisions(active);
  // Countdown stays role=timer without aria-live: per-second announcements
  // would monopolize the screen-reader queue for every visible approval.
  const remaining = approvalRemainingLabel(active.expiresAtMs, props.nowMs);
  const title = approvalTitle(active);
  return html`
    <div
      class="exec-approval-card exec-approval-card--${props.variant}"
      data-approval-id=${active.id}
    >
      <div class="exec-approval-header">
        <div>
          <div class="exec-approval-title">${title}</div>
          <div class="exec-approval-sub exec-approval-countdown" role="timer">${remaining}</div>
        </div>
        ${(props.queueCount ?? 0) > 1
          ? html`<div class="exec-approval-queue">
              ${t("execApproval.pending", { count: String(props.queueCount) })}
            </div>`
          : nothing}
      </div>
      ${active.kind === "exec" ? renderExecBody(active.request) : renderPluginBody(active)}
      ${renderUnavailableDecisionWarning(active, decisions)}
      ${props.error ? html`<div class="exec-approval-error">${props.error}</div>` : nothing}
      <div class="exec-approval-actions">
        ${decisions.map((decision) => {
          const label = approvalDecisionLabel(decision);
          const shortcut = approvalDecisionShortcut(decision);
          return html`
            <button
              class=${approvalDecisionClass(decision)}
              type="button"
              ?disabled=${props.busy}
              title=${props.variant === "modal" ? `${label} (${shortcut})` : label}
              @click=${() => props.onDecision(active.id, decision)}
            >
              <span>${label}</span>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

function compactCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 64 ? `${singleLine.slice(0, 61)}…` : singleLine;
}

function renderApprovalQueueList(params: {
  queue: readonly ExecApprovalRequest[];
  activeId: string;
  nowMs: number;
  onSelect: (approvalId: string) => void;
}) {
  const others = params.queue.filter((entry) => entry.id !== params.activeId);
  if (others.length === 0) {
    return nothing;
  }
  return html`
    <div class="exec-approval-list" aria-label=${t("execApproval.otherPending")}>
      <div class="exec-approval-list__heading">${t("execApproval.otherPending")}</div>
      ${others.map((entry) => {
        const command = compactCommand(entry.request.command);
        const agent = entry.request.agentId?.trim() || "—";
        const countdown = formatApprovalCountdown(entry.expiresAtMs, params.nowMs);
        return html`
          <button
            class="exec-approval-list__item"
            type="button"
            aria-label=${t("execApproval.reviewRequest", { agent, command })}
            @click=${() => params.onSelect(entry.id)}
          >
            <span class="exec-approval-list__agent">${agent}</span>
            <span class="exec-approval-list__command mono">${command}</span>
            <span class="exec-approval-list__expiry" aria-hidden="true">${countdown}</span>
          </button>
        `;
      })}
    </div>
  `;
}

function keyEventComesFromTextEntry(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") !==
          null,
    );
}

// Authorization shortcuts require a Ctrl/Cmd chord: the modal steals focus
// when it opens, so a bare letter typed mid-sentence into the composer could
// otherwise approve a command the user never read.
function shortcutDecision(event: KeyboardEvent): ExecApprovalDecision | null {
  const hasModChord = (event.metaKey || event.ctrlKey) && !event.altKey;
  if (!hasModChord || keyEventComesFromTextEntry(event)) {
    return null;
  }
  if (event.key === "Enter") {
    return event.shiftKey ? "allow-always" : "allow-once";
  }
  return !event.shiftKey && event.key.toLowerCase() === "d" ? "deny" : null;
}

class ExecApproval extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: ExecApprovalProps;
  @query("openclaw-modal-dialog") private dialog?: OpenClawModalDialog;
  @state() private selectedApprovalId: string | null = null;
  @state() private forceShowAll = false;

  show(): void {
    this.forceShowAll = true;
    void this.updateComplete.then(() => this.dialog?.show());
  }

  private displayedQueue(): readonly ExecApprovalRequest[] {
    const props = this.props;
    if (!props) {
      return [];
    }
    return this.forceShowAll
      ? props.queue
      : modalApprovalQueue(props.queue, props.inlineApprovalId);
  }

  private activeApproval(queue: readonly ExecApprovalRequest[]): ExecApprovalRequest | null {
    return queue.find((entry) => entry.id === this.selectedApprovalId) ?? queue.at(0) ?? null;
  }

  private handleKeydown(event: KeyboardEvent, active: ExecApprovalRequest): void {
    // A held chord auto-repeats: once a decision settles and the queue
    // advances, the repeat would apply the same decision to the next request.
    if (event.defaultPrevented || event.repeat || this.props?.busy) {
      return;
    }
    const decision = shortcutDecision(event);
    if (!decision || !resolveApprovalDecisions(active).includes(decision)) {
      return;
    }
    event.preventDefault();
    void this.props?.onDecision(active.id, decision);
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    const previousProps = changedProperties.get("props") as ExecApprovalProps | undefined;
    if (previousProps?.queue.length && !this.props?.queue.length) {
      this.forceShowAll = false;
      this.selectedApprovalId = null;
      return;
    }
    // Pin the presented request: late-arriving older approvals re-sort the
    // queue, and swapping the card mid-read (or mid-decision) could attach the
    // user's answer or a failure message to a request they never saw.
    const displayedQueue = this.displayedQueue();
    if (!displayedQueue.some((entry) => entry.id === this.selectedApprovalId)) {
      this.selectedApprovalId = displayedQueue.at(0)?.id ?? null;
    }
  }

  override render() {
    const props = this.props;
    const queue = this.displayedQueue();
    const active = this.activeApproval(queue);
    if (!props || !active) {
      return nothing;
    }
    const decisions = resolveApprovalDecisions(active);
    const handleCancel = () => {
      if (!props.busy && decisions.includes("deny")) {
        void props.onDecision(active.id, "deny");
      }
    };
    return html`
      <openclaw-modal-dialog
        label=${approvalTitle(active)}
        description=${approvalRemainingLabel(active.expiresAtMs, props.nowMs)}
        @keydown=${(event: KeyboardEvent) => this.handleKeydown(event, active)}
        @modal-cancel=${handleCancel}
      >
        <div class="exec-approval-modal-stack">
          ${renderExecApprovalCard({
            approval: active,
            busy: props.busy,
            error: props.errors.get(active.id) ?? null,
            nowMs: props.nowMs,
            variant: "modal",
            queueCount: queue.length,
            onDecision: props.onDecision,
          })}
          ${renderApprovalQueueList({
            queue,
            activeId: active.id,
            nowMs: props.nowMs,
            onSelect: (approvalId) => {
              this.selectedApprovalId = approvalId;
            },
          })}
        </div>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("openclaw-exec-approval")) {
  customElements.define("openclaw-exec-approval", ExecApproval);
}
