import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { isMobileNavLayout, mobileNavLayoutMediaQuery } from "../app/mobile-nav-layout.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createMediaQuery } from "../lib/reactive/platform.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { SidebarCollapseToggle } from "./sidebar-collapse-toggle.tsx";
import type { SidebarMenus } from "./sidebar-menus.tsx";
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
  menu: "peopleFilter" | "sessionSort";
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

export function SidebarPagesHeader(props: { host: AppSidebarRenderHost }) {
  return (
    <SidebarPanelHeader onToggleSidebar={props.host.onToggleSidebar}>
      <span class="sidebar-panel-header__title">{t("nav.pages")}</span>
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
        fallback={<span class="sidebar-panel-header__title">{t("presence.usersTitle")}</span>}
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
