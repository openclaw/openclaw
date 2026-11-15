import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import { isMobileNavLayout, mobileNavLayoutMediaQuery } from "../app/mobile-nav-layout.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createMediaQuery } from "../lib/reactive/platform.ts";
import { automationsFiltered } from "./app-sidebar-automations-filter.tsx";
import { dashboardsFiltered } from "./app-sidebar-dashboards-filter.tsx";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { SidebarCollapseToggle } from "./sidebar-collapse-toggle.tsx";
import type { SidebarFilterMenu, SidebarMenus } from "./sidebar-menus.tsx";
import { Icon } from "./solid/icon.tsx";
import { Picker } from "./solid/select-picker.tsx";

/** Every panel header renders above the list scroller with one geometry, so it stays pinned
    and clears the scrollbar gutter on Sessions, Pages, and Users alike. */
export function SidebarPanelHeader(props: {
  class?: string;
  onToggleSidebar?: () => void;
  children: JSX.Element;
}) {
  return (
    <div class={["sidebar-panel-header", props.class]} onMouseDown={beginNativeWindowDrag}>
      {props.children}
      <SidebarCollapseToggle onToggle={() => props.onToggleSidebar?.()} />
    </div>
  );
}

export function SidebarPanelFilter(props: {
  menus: Pick<SidebarMenus, "togglePositionedMenu">;
  menu: SidebarFilterMenu;
  expanded: boolean;
  filtered: boolean;
  title: string;
  label: string;
  description?: string;
  class?: string;
}) {
  return (
    <button
      type="button"
      class={[
        "sidebar-session-toolbar__button sidebar-session-sort",
        props.class,
        { "sidebar-session-sort--filtered": props.filtered },
      ]}
      title={props.title}
      aria-label={props.label}
      aria-description={props.description}
      aria-haspopup="dialog"
      aria-expanded={props.expanded ? "true" : "false"}
      onClick={(event: MouseEvent) => {
        if (event.currentTarget instanceof HTMLElement) {
          props.menus.togglePositionedMenu(props.menu, event.currentTarget);
        }
      }}
    >
      <Icon name="listFilter" />
    </button>
  );
}

export function SidebarDashboardsHeader(props: { host: AppSidebarRenderHost }) {
  return (
    <SidebarPanelHeader onToggleSidebar={props.host.onToggleSidebar}>
      <span class="sidebar-panel-header__title">{titleForRoute("dashboards", t)}</span>
      <SidebarPanelFilter
        menus={props.host.sidebarMenus}
        menu="dashboardsFilter"
        expanded={props.host.sidebarMenus.dashboardsFilterMenuPosition !== null}
        filtered={dashboardsFiltered()}
        title={t("chat.sidebar.menuFilters")}
        label={t("chat.sidebar.menuFilters")}
      />
    </SidebarPanelHeader>
  );
}

export function SidebarAutomationsHeader(props: { host: AppSidebarRenderHost }) {
  return (
    <SidebarPanelHeader onToggleSidebar={props.host.onToggleSidebar}>
      <span class="sidebar-panel-header__title">{titleForRoute("cron", t)}</span>
      <SidebarPanelFilter
        menus={props.host.sidebarMenus}
        menu="automationsFilter"
        expanded={props.host.sidebarMenus.automationsFilterMenuPosition !== null}
        filtered={automationsFiltered()}
        title={t("cron.list.filters")}
        label={t("cron.list.filters")}
      />
    </SidebarPanelHeader>
  );
}

export function SidebarCustomizeHeader(props: { host: AppSidebarRenderHost }) {
  return (
    <SidebarPanelHeader onToggleSidebar={props.host.onToggleSidebar}>
      <span class="sidebar-panel-header__title">{titleForRoute("plugins", t)}</span>
    </SidebarPanelHeader>
  );
}

/** A page that brings its own sidebar list, like Systems, heads it with its own title. */
export function SidebarPageHeader(props: { host: AppSidebarRenderHost; route: NavigationRouteId }) {
  return (
    <SidebarPanelHeader onToggleSidebar={props.host.onToggleSidebar}>
      <span class="sidebar-panel-header__title">{titleForRoute(props.route, t)}</span>
    </SidebarPanelHeader>
  );
}

export function SidebarOnlineHeader(props: { host: AppSidebarRenderHost }) {
  const mobile = createMediaQuery(mobileNavLayoutMediaQuery(), isMobileNavLayout());
  const people = () => props.host.people;
  return (
    <SidebarPanelHeader onToggleSidebar={props.host.onToggleSidebar}>
      <Show
        when={mobile()}
        fallback={<span class="sidebar-panel-header__title">{t("presence.peopleTitle")}</span>}
      >
        <Picker
          id="sidebar-people-presence"
          class="sidebar-session-owner-filter"
          triggerIcon="chevronsUpDown"
          label={t("presence.usersTitle")}
          value={people().presenceFilter}
          sheet
          showOptionTooltips={false}
          options={[
            { value: "online", label: t("presence.rosterTitle") },
            { value: "all", label: t("presence.allUsers") },
          ]}
          onChange={(value) => {
            if (value === "online" || value === "all") {
              people().set("presenceFilter", value);
            }
          }}
        />
      </Show>
      <SidebarPanelFilter
        menus={props.host.sidebarMenus}
        menu="peopleFilter"
        class="sidebar-online__filter-toggle"
        expanded={props.host.sidebarMenus.peopleFilterMenuPosition !== null}
        filtered={
          people().statusFilter === "running" || (!mobile() && people().presenceFilter === "all")
        }
        title={t("presence.filters.label")}
        label={t("presence.filters.label")}
      />
    </SidebarPanelHeader>
  );
}
