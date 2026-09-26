import { html, nothing } from "lit";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import type { SessionListHost } from "./app-sidebar-session-row-render.ts";
import { icons } from "./icons.ts";
import { renderNewSessionLink } from "./new-session-link.ts";
import { renderSessionOwnerAvatar, sessionSelfOwner } from "./session-owner-chip.ts";

/**
 * Quiet toolbar summary of the active sidebar filters. The whole control clears
 * them; its lead glyph (owner avatar, or an archive mark for status-only
 * filters) turns into the clear icon on hover so the row spends no width on a
 * second affordance.
 */
function renderSessionFilterSummary(host: SessionListHost) {
  const ownerId = host.sessionOwnerFilterActive ? host.sessionOwnerFilterId : null;
  const owner = ownerId
    ? host.sessionOwnerOptions.find((option) => option.id === ownerId)
    : host.sessionInvolvingMeFilterActive
      ? sessionSelfOwner(
          resolveCurrentSelfUser({
            snapshotUser: host.sessionDataContext?.gateway.snapshot.selfUser,
            presenceEntries: readPresenceEntries(host.sessionData.presencePayload),
            presenceInstanceId: host.sessionData.presenceInstanceId,
          }),
        )
      : undefined;
  const parts = [
    ...(ownerId ? [owner?.label ?? ownerId] : []),
    ...(host.sessionInvolvingMeFilterActive ? [t("sessionsView.involvingMe")] : []),
    ...(host.sessionsStatusFilter === "archived"
      ? [t("sessionsView.archived")]
      : host.sessionsStatusFilter === "all"
        ? [t("sessionsView.all")]
        : []),
  ];
  const summaryText = parts.join(" · ");
  const showAll = t("chat.sidebar.showAllSessions");
  return html`<button
    type="button"
    class="sidebar-session-filter-summary"
    title=${showAll}
    aria-label=${`${summaryText} · ${showAll}`}
    @click=${() => {
      host.setSessionOwnerFilter(null);
      if (host.sessionsStatusFilter !== "active") {
        host.sessionOrganizer.setSessionsStatusFilter("active");
      }
    }}
  >
    <span class="sidebar-session-filter-summary__lead" aria-hidden="true">
      <span class="sidebar-session-filter-summary__glyph"
        >${owner ? renderSessionOwnerAvatar(owner) : icons.archive}</span
      >
      <span class="sidebar-session-filter-summary__clear">${icons.x}</span>
    </span>
    <span class="sidebar-session-filter-summary__label"
      >${parts.map(
        (part, index) =>
          html`${
            index > 0
              ? html`<span class="sidebar-session-filter-summary__sep" aria-hidden="true">·</span>`
              : nothing
          }${part}`,
      )}</span
    >
  </button>`;
}

export function renderSidebarSessionFilter(
  host: Pick<
    SessionListHost,
    | "sidebarMenus"
    | "sessionOwnerFilterActive"
    | "sessionInvolvingMeFilterActive"
    | "sessionsStatusFilter"
  >,
  className: string,
) {
  const filtered =
    host.sessionOwnerFilterActive ||
    host.sessionInvolvingMeFilterActive ||
    host.sessionsStatusFilter !== "active";
  return html`<button
    type="button"
    class="${className} sidebar-session-sort ${filtered ? "sidebar-session-sort--filtered" : ""}"
    title=${t("chat.sidebar.sortSessions")}
    aria-label=${t("chat.sidebar.sortSessions")}
    aria-haspopup="menu"
    aria-expanded=${String(host.sidebarMenus.sessionSortMenuPosition !== null)}
    @click=${(event: MouseEvent) => {
      if (event.currentTarget instanceof HTMLElement) {
        host.sidebarMenus.toggleSessionSortMenu(event.currentTarget);
      }
    }}
  >
    ${icons.listFilter}
  </button>`;
}

export function renderSessionListToolbar(host: SessionListHost) {
  const newSessionAccess = host.readNewSessionAccess();
  const filtered =
    host.sessionOwnerFilterActive ||
    host.sessionInvolvingMeFilterActive ||
    host.sessionsStatusFilter !== "active";
  return html`
    <div class="sidebar-session-toolbar">
      <span class="sidebar-recent-sessions__label-text">${t("chat.sidebar.threads")}</span>
      ${filtered ? renderSessionFilterSummary(host) : nothing}
      ${renderSidebarSessionFilter(host, "sidebar-session-toolbar__button")}
      ${renderNewSessionLink({
        basePath: host.basePath,
        agentId: host.expandedAgentId(),
        className: "sidebar-session-toolbar__button sidebar-new-session",
        label: t("agentChip.newConversation"),
        showShortcut: true,
        disabledReason: newSessionAccess.allowed ? undefined : newSessionAccess.reason,
        onOpen: (agentId, target) => host.requestOpenNewSession(agentId, target),
      })}
    </div>
  `;
}

export function renderSessionMutationError(host: Pick<SessionListHost, "sessionData">) {
  return host.sessionData.sessionMutationError
    ? html`
        <div
          class="sidebar-session-error callout danger callout--dismissible"
          role="alert"
          data-sidebar-session-error
        >
          <span class="callout__content">${host.sessionData.sessionMutationError}</span>
          <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
            <button
              class="callout__dismiss"
              type="button"
              @click=${() => host.sessionData.dismissSessionMutationError()}
              aria-label=${t("chat.actions.dismissError")}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        </div>
      `
    : nothing;
}

/** Each list supplies settlement from its own request owner, not its sibling's cache. */
export function renderPersonalSessionEmpty(
  host: Pick<
    SessionListHost,
    "sessionsStatusFilter" | "sessionOwnerFilterActive" | "sessionInvolvingMeFilterActive"
  >,
  empty: boolean,
  settled: boolean,
) {
  return empty &&
    settled &&
    host.sessionsStatusFilter === "active" &&
    (host.sessionOwnerFilterActive || host.sessionInvolvingMeFilterActive)
    ? html`<span class="sidebar-session-empty-hint"
        >${t("chat.sidebar.noActiveSessionsForFilter")}</span
      >`
    : nothing;
}
