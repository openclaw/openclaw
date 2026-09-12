import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { formatWebUiIconErrorText } from "./error-presentation.ts";
import { icons } from "./icons.ts";
import { resolveSessionAttentionIcon } from "./session-attention-icon-registry.ts";
import { renderSessionGlyph } from "./session-glyph.ts";

function keepQuestionFocusOnTooltip(event: FocusEvent) {
  // The hand is its own tooltip target; bubbling would also open the row hovercard.
  event.stopPropagation();
}

export function renderSessionAttentionIcon(
  attention: SidebarSessionAttention,
  showQuestionTooltip = false,
) {
  if (attention.kind === "none") {
    return nothing;
  }
  const questionLabel = attention.kind === "question" ? sessionAttentionSubtitle(attention) : null;
  const icon =
    attention.kind === "question"
      ? icons.hand
      : attention.kind === "approval"
        ? icons.shieldQuestion
        : attention.kind === "agent"
          ? resolveSessionAttentionIcon(attention.icon)
          : icons.alertTriangle;
  const content = html`<span
    class="sidebar-session-attention__icon sidebar-session-attention__icon--${attention.kind}"
    data-session-attention=${attention.kind}
    role=${questionLabel ? "img" : nothing}
    aria-label=${questionLabel ?? nothing}
    aria-hidden=${questionLabel ? nothing : "true"}
    tabindex=${questionLabel ? "0" : nothing}
    @focusin=${questionLabel ? keepQuestionFocusOnTooltip : nothing}
    >${icon}</span
  >`;
  return showQuestionTooltip && questionLabel
    ? html`<openclaw-tooltip .content=${questionLabel}>${content}</openclaw-tooltip>`
    : content;
}

export function sessionAttentionSubtitle(attention: SidebarSessionAttention): string | undefined {
  switch (attention.kind) {
    case "question":
      return t("sessionsView.waitingForAnswer");
    case "approval":
      return t("sessionsView.waitingForApproval");
    case "error":
      return t("sessionsView.runFailedReason", {
        reason: formatWebUiIconErrorText(attention.reason),
      });
    case "agent":
      return attention.note;
    case "none":
      return undefined;
    default:
      return attention satisfies never;
  }
}

export function renderSessionState(session: SidebarRecentSession) {
  if (session.hasActiveRun) {
    const queued = session.hasActiveRun && session.status === "queued";
    return renderSessionGlyph({ content: nothing, running: true, queued });
  }
  if (!session.isChild) {
    return session.unread
      ? html`<span
          class="session-unread-dot sidebar-recent-session__unread"
          role="img"
          aria-label=${t("sessionsView.unread")}
        ></span>`
      : nothing;
  }
  const status = session.status;
  if (!status) {
    return nothing;
  }
  const statusBadge =
    status === "done"
      ? { icon: icons.check, label: t("sessionsView.statusDone") }
      : status === "killed"
        ? { icon: icons.stop, label: t("sessionsView.statusKilled") }
        : status === "timeout"
          ? { icon: icons.alertTriangle, label: t("sessionsView.statusTimeout") }
          : status === "failed"
            ? { icon: icons.alertTriangle, label: t("sessionsView.statusFailed") }
            : null;
  return statusBadge
    ? html`<span
        class="sidebar-child-session__status sidebar-child-session__status--${status}"
        role="img"
        aria-label=${statusBadge.label}
        title=${statusBadge.label}
        >${statusBadge.icon}</span
      >`
    : nothing;
}

/** Keep each attention fact accessible once when its text moves out of the row. */
export function renderCompactSessionAttention(attention: SidebarSessionAttention) {
  if (attention.kind === "none") {
    return nothing;
  }
  if (attention.kind === "question") {
    return renderSessionAttentionIcon(attention, true);
  }
  const label = sessionAttentionSubtitle(attention);
  return html`<openclaw-tooltip .content=${label}
    ><span role="img" aria-label=${label}
      >${renderSessionAttentionIcon(attention)}</span
    ></openclaw-tooltip
  >`;
}

/** Render the existing tree projection without conflating an agent/parent's own run with descendants. */
export function renderSessionTreeSummary(
  rows: readonly SidebarRecentSession[],
  descendantsOnly = false,
) {
  const attention = [
    ...new Map(
      rows
        .flatMap((row) => [
          ...(descendantsOnly ? [] : [row.ownAttention ?? row.attention]),
          ...(row.childAttention ?? []),
        ])
        .filter((value) => value.kind !== "none")
        .map((value) => [value.kind, value]),
    ).values(),
  ];
  const active = rows.reduce(
    (n, row) => n + (descendantsOnly ? 0 : Number(row.hasActiveRun)) + row.runningChildCount,
    0,
  );
  const queued = rows.reduce(
    (n, row) =>
      n +
      (descendantsOnly ? 0 : Number(row.hasActiveRun && row.status === "queued")) +
      (row.queuedChildCount ?? 0),
    0,
  );
  const running = Math.max(0, active - queued);
  const unread = rows.reduce(
    (n, row) => n + (descendantsOnly ? 0 : Number(row.unread)) + (row.unreadChildCount ?? 0),
    0,
  );
  const failed = rows.reduce(
    (n, row) =>
      n +
      (descendantsOnly ? 0 : Number(row.status === "failed" || row.status === "timeout")) +
      row.failedChildCount,
    0,
  );
  const conflicts = descendantsOnly
    ? 0
    : rows.reduce((n, row) => n + (row.workspaceConflictCount ?? 0), 0);
  if (attention.length === 0 && !active && !unread && !failed && !conflicts) {
    return nothing;
  }
  return html`<span
    class="sidebar-tree-summary"
    role="group"
    aria-label=${descendantsOnly ? t("sessionsView.childSessions") : t("chat.sidebar.threads")}
  >
    ${attention.map(renderCompactSessionAttention)}
    ${failed > 0 && !attention.some((value) => value.kind === "error") ? html`<span class="sidebar-child-session__status--failed" role="img" aria-label=${t("sessionsView.statusFailed")} title=${t("sessionsView.statusFailed")}>${icons.alertTriangle}</span>` : nothing}
    ${conflicts > 0 ? html`<span role="img" aria-label=${t("sessionsView.cloudWorkerDescendantConflicts", { count: String(conflicts) })} title=${t("sessionsView.cloudWorkerDescendantConflicts", { count: String(conflicts) })}>${icons.globe}</span>` : nothing}
    ${running > 0 ? html`<span class="session-run-spinner" role="img" aria-label=${t("sessionsView.activeRun")} title=${t("sessionsView.activeRun")}></span>` : nothing}
    ${queued > 0 ? renderSessionGlyph({ content: nothing, running: true, queued: true }) : nothing}
    ${unread > 0 ? html`<span class="sidebar-agent-roster__unread" role="img" aria-label=${t("sessionsView.unread")} title=${t("sessionsView.unread")}>${unread}</span>` : nothing}
  </span>`;
}
