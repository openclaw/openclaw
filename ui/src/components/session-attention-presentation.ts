import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import {
  sidebarSessionAttentionPriority,
  type SidebarRecentSession,
  type SidebarSessionAttention,
} from "./app-sidebar-session-types.ts";
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

export function renderSessionIdleState(session: SidebarRecentSession) {
  if (!session.isChild) {
    return session.unread
      ? html`<span
          class="session-unread-dot"
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
function renderCompactSessionAttention(attention: SidebarSessionAttention) {
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

/** Share compact indicators between rows and collapsed groups; attention outranks activity. */
export function renderTeamSessionSlots(
  rows: readonly SidebarRecentSession[],
  includeChildren: boolean,
  childCount: number,
  groupConflicts = 0,
) {
  const attention = rows
    .flatMap((row) => [
      row.ownAttention ?? row.attention,
      ...(includeChildren ? (row.childAttention ?? []) : []),
    ])
    .toSorted((a, b) => sidebarSessionAttentionPriority(b) - sidebarSessionAttentionPriority(a))[0];
  const active = rows.reduce(
    (n, row) => n + Number(row.hasActiveRun) + (includeChildren ? row.runningChildCount : 0),
    0,
  );
  const queued = rows.reduce(
    (n, row) =>
      n +
      Number(row.hasActiveRun && row.status === "queued") +
      (includeChildren ? (row.queuedChildCount ?? 0) : 0),
    0,
  );
  const unread = rows.reduce(
    (n, row) => n + Number(row.unread) + (includeChildren ? (row.unreadChildCount ?? 0) : 0),
    0,
  );
  const failed = rows.some(
    (row) =>
      row.status === "failed" ||
      row.status === "timeout" ||
      (includeChildren && row.failedChildCount > 0),
  );
  const state =
    attention && attention.kind !== "none"
      ? renderCompactSessionAttention(attention)
      : failed
        ? html`<span
            class="sidebar-child-session__status--failed"
            role="img"
            aria-label=${t("sessionsView.statusFailed")}
            >${icons.alertTriangle}</span
          >`
        : groupConflicts
          ? html`<span
              role="img"
              aria-label=${t("sessionsView.cloudWorkerDescendantConflicts", { count: String(groupConflicts) })}
              >${icons.globe}</span
            >`
          : active
            ? renderSessionGlyph({ content: nothing, running: true, queued: active === queued })
            : rows.length === 1 && rows[0]?.isChild
              ? renderSessionIdleState(rows[0])
              : nothing;
  if ((!includeChildren || childCount === 0) && unread === 0 && state === nothing) {
    return nothing;
  }
  return html`<span class="sidebar-session-team-state">
    ${includeChildren && childCount > 0 ? html`<span class="sidebar-child-session-toggle__count" role="img" aria-label=${`${t("sessionsView.childSessions")}: ${childCount}`}>${childCount}</span>` : nothing}
    ${unread > 0 ? html`<span class=${unread === 1 ? "session-unread-dot" : "sidebar-agent-roster__unread"} role="img" aria-label=${t("sessionsView.unread")} title=${t("sessionsView.unread")}>${unread > 1 ? unread : nothing}</span>` : nothing}
    ${state === nothing ? nothing : html`<span class="sidebar-session-team-state__status">${state}</span>`}
  </span>`;
}
