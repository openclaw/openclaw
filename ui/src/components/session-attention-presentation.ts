import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import {
  summarizeSidebarSessionAttention,
  type SidebarRecentSession,
  type SidebarSessionAttention,
} from "./app-sidebar-session-types.ts";
import { formatWebUiIconErrorText } from "./error-presentation.ts";
import { icons } from "./icons.ts";
import { resolveSessionAttentionIcon } from "./session-attention-icon-registry.ts";
import { renderSessionGlyph } from "./session-glyph.ts";

function keepAttentionFocusOnTooltip(event: FocusEvent) {
  // Attention is its own tooltip target; bubbling would also open the row hovercard.
  event.stopPropagation();
}

function revealAttentionWithoutNavigation(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

export function renderSessionAttentionIcon(
  attention: SidebarSessionAttention,
  showTooltip = false,
) {
  if (attention.kind === "none") {
    return nothing;
  }
  const label = showTooltip ? sessionAttentionTooltipLabel(attention) : undefined;
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
    role=${label ? "img" : nothing}
    aria-label=${label ?? nothing}
    aria-hidden=${label ? nothing : "true"}
    tabindex=${label ? "0" : nothing}
    @focusin=${label ? keepAttentionFocusOnTooltip : nothing}
    @click=${label ? revealAttentionWithoutNavigation : nothing}
    >${icon}</span
  >`;
  return showTooltip && label ? renderSessionAttentionTooltip(attention, content) : content;
}

export function sessionAttentionSubtitle(attention: SidebarSessionAttention): string | undefined {
  switch (attention.kind) {
    case "question":
      return t("sessionsView.waitingForAnswer");
    case "approval":
      return t("sessionsView.waitingForApproval");
    case "error":
      return t(
        attention.childLabel === undefined
          ? "sessionsView.runFailedReason"
          : "sessionsView.childRunFailedReason",
        {
          label: attention.childLabel ?? "",
          reason: formatWebUiIconErrorText(attention.reason),
        },
      );
    case "agent":
      return attention.note;
    case "none":
      return undefined;
    default:
      return attention satisfies never;
  }
}

function sessionAttentionTooltipParts(attention: SidebarSessionAttention) {
  const subtitle = sessionAttentionSubtitle(attention);
  if (attention.kind !== "question" && attention.kind !== "approval") {
    return { status: subtitle };
  }
  const requests = attention.requests.filter((request) => request.kind === attention.kind);
  const count = requests.reduce((total, request) => total + request.count, 0);
  return {
    status:
      count > 1
        ? t(
            attention.kind === "question"
              ? "sessionsView.questionsNeedAnswer"
              : "sessionsView.approvalsNeedApproval",
            { count: String(count) },
          )
        : subtitle,
    preview: requests[0]?.preview,
    more: count > 1 ? t("sessionsView.attentionMore", { count: String(count - 1) }) : undefined,
  };
}

export function sessionAttentionTooltipLabel(
  attention: SidebarSessionAttention,
): string | undefined {
  const { status, preview, more } = sessionAttentionTooltipParts(attention);
  return [status, preview, more].filter(Boolean).join("\n") || undefined;
}

function renderSessionAttentionTooltip(
  attention: SidebarSessionAttention,
  trigger: TemplateResult,
) {
  const { status, preview, more } = sessionAttentionTooltipParts(attention);
  return html`<openclaw-tooltip .content=${preview ? "" : status} open-on-click>
    ${trigger}
    ${
      preview
        ? html`<span slot="content" class="sidebar-session-attention-tooltip">
            <strong>${status}</strong>
            <span class="sidebar-session-attention-tooltip__preview">${preview}</span>
            ${more ? html`<span>${more}</span>` : nothing}
          </span>`
        : nothing
    }
  </openclaw-tooltip>`;
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

/** Share compact indicators between rows and collapsed groups; attention outranks activity. */
export function renderTeamSessionSlots(
  rows: readonly SidebarRecentSession[],
  includeChildren: boolean,
  childCount: number,
  groupConflicts = 0,
) {
  const attention = summarizeSidebarSessionAttention(
    rows.flatMap((row) =>
      includeChildren
        ? [row.attention]
        : [
            row.ownAttention ?? row.attention,
            ...(row.subagentSummary ? [row.subagentSummary.attention] : []),
          ],
    ),
  );
  let active = 0;
  let queued = 0;
  let unread = 0;
  let failed = false;
  for (const row of rows) {
    const children = includeChildren ? row : row.subagentSummary;
    active += Number(row.hasActiveRun) + (children?.runningChildCount ?? 0);
    queued +=
      Number(row.hasActiveRun && row.status === "queued") + (children?.queuedChildCount ?? 0);
    unread += Number(row.unread) + (children?.unreadChildCount ?? 0);
    failed ||=
      row.status === "failed" || row.status === "timeout" || (children?.failedChildCount ?? 0) > 0;
  }
  const state =
    attention && attention.kind !== "none"
      ? renderSessionAttentionIcon(attention, true)
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
    ${
      (includeChildren && childCount > 0) || unread > 0
        ? html`<span class="sidebar-session-team-state__counts">
            ${includeChildren && childCount > 0 ? html`<span class="sidebar-child-session-toggle__count" role="img" aria-label=${`${t("sessionsView.childSessions")}: ${childCount}`}>${childCount}</span>` : nothing}
            ${unread > 0 ? html`<span class=${unread === 1 ? "session-unread-dot" : "sidebar-agent-roster__unread"} role="img" aria-label=${t("sessionsView.unread")} title=${t("sessionsView.unread")}>${unread > 1 ? unread : nothing}</span>` : nothing}
          </span>`
        : nothing
    }
    ${state === nothing ? nothing : html`<span class="sidebar-session-team-state__status">${state}</span>`}
  </span>`;
}
