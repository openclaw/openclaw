import { lazy, Loading, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { SidebarPanelFilter, SidebarPanelHeader } from "./app-sidebar-panel-headers.tsx";
import { SidebarNewSessionAction, type AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import { InlineAlert } from "./solid/inline-alert.tsx";

const SidebarOwnerPicker = lazy(() => import("./sidebar-owner-picker.runtime.tsx"), {
  export: "SidebarOwnerPicker",
});

/** Only the panel's Status choice contributes to its filter indicator. */
export function countSidebarSessionFilters(host: Pick<SessionListHost, "sessionsStatusFilter">) {
  return Number(host.sessionsStatusFilter !== "active");
}

export function renderSessionListToolbar(
  host: SessionListHost & Pick<AppSidebarRenderHost, "onToggleSidebar">,
) {
  const title = () => <span class="sidebar-panel-header__title">{t("chat.sidebar.threads")}</span>;
  const hasOwnerPicker = () => {
    const owners = host.sessionOwnerOptions;
    return (
      (host.sessionOwnershipVisibility.filters && owners.length > 0) ||
      host.sessionOwnerFilterId !== null ||
      host.sessionInvolvingMeFilterActive
    );
  };
  const statusLabel = () =>
    host.sessionsStatusFilter === "active"
      ? t("common.active")
      : t(`sessionsView.${host.sessionsStatusFilter}`);
  return (
    <SidebarPanelHeader class="sidebar-session-toolbar" onToggleSidebar={host.onToggleSidebar}>
      <Show when={hasOwnerPicker()} fallback={title()}>
        <Loading fallback={title()}>
          <SidebarOwnerPicker host={host} />
        </Loading>
      </Show>
      <SidebarPanelFilter
        menus={host.sidebarMenus}
        menu="sessionSort"
        expanded={host.sidebarMenus.sessionSortMenuPosition !== null}
        filtered={countSidebarSessionFilters(host) > 0}
        title={t("chat.sidebar.sortSessions")}
        label={`${t("chat.sidebar.sortSessions")} · ${statusLabel()}`}
        description={`${t("sessionsView.status")}: ${statusLabel()}`}
      />
      <SidebarNewSessionAction
        host={host}
        class="sidebar-session-toolbar__button sidebar-new-session"
      />
    </SidebarPanelHeader>
  );
}
export function renderSessionListError(host: Pick<SessionListHost, "sessionData">) {
  return host.sessionData.sessionListError ? (
    <InlineAlert
      tone="danger"
      class="sidebar-session-error"
      data-sidebar-session-error=""
      onDismiss={() => host.sessionData.dismissSessionListError()}
      dismissLabel={t("chat.actions.dismissError")}
    >
      {host.sessionData.sessionListError}
    </InlineAlert>
  ) : undefined;
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
    (host.sessionOwnerFilterActive || host.sessionInvolvingMeFilterActive) ? (
    <span class="sidebar-session-empty-hint">{t("chat.sidebar.noActiveSessionsForFilter")}</span>
  ) : undefined;
}
