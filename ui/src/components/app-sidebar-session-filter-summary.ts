import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { renderSidebarOwnerPicker } from "./app-sidebar-owner-picker.ts";
import type { SessionListHost } from "./app-sidebar-session-row-render.ts";
import { icons } from "./icons.ts";
import { renderNewSessionLink } from "./new-session-link.ts";

type SessionFilterHost = Pick<SessionListHost, "sessionsStatusFilter">;

/** Only the panel's Status choice contributes to its filter indicator. */
export function countSidebarSessionFilters(host: SessionFilterHost) {
  return Number(host.sessionsStatusFilter !== "active");
}

export function renderSidebarSessionFilter(
  host: SessionFilterHost & Pick<SessionListHost, "sidebarMenus">,
  className: string,
) {
  const count = countSidebarSessionFilters(host);
  return html`<button
    type="button"
    class="${className} sidebar-session-sort ${count > 0 ? "sidebar-session-sort--filtered" : ""}"
    title=${t("chat.sidebar.sortSessions")}
    aria-label=${t("chat.sidebar.sortSessions")}
    aria-description=${count > 0 ? t("chat.sidebar.activeFilterCount", { count: String(count) }) : nothing}
    aria-haspopup="dialog"
    aria-expanded=${String(host.sidebarMenus.sessionSortMenuPosition !== null)}
    @click=${(event: MouseEvent) => {
      if (event.currentTarget instanceof HTMLElement) {
        host.sidebarMenus.togglePositionedMenu("sessionSort", event.currentTarget);
      }
    }}
  >
    ${icons.listFilter}
  </button>`;
}

export function renderSessionListToolbar(host: SessionListHost, teamNewSession?: unknown) {
  const newSessionAccess = host.readNewSessionAccess();
  return html`
    <div class="sidebar-session-toolbar">
      ${renderSidebarOwnerPicker(host)}
      ${renderSidebarSessionFilter(host, "sidebar-session-toolbar__button")}
      ${
        teamNewSession ??
        renderNewSessionLink({
          basePath: host.basePath,
          agentId: host.expandedAgentId(),
          className: "sidebar-session-toolbar__button sidebar-new-session",
          label: t("agentChip.newConversation"),
          showShortcut: true,
          disabledReason: newSessionAccess.allowed ? undefined : newSessionAccess.reason,
          onOpen: (agentId, target) => host.requestOpenNewSession(agentId, target),
        })
      }
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
