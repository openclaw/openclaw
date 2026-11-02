import { createMemo, Show } from "solid-js";
import { isMobileNavLayout, mobileNavLayoutMediaQuery } from "../app/mobile-nav-layout.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createMediaQuery } from "../lib/reactive/platform.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { SidebarCollapseToggle } from "./sidebar-collapse-toggle.tsx";
import { Icon } from "./solid/icon.tsx";
import { Picker } from "./solid/select-picker.tsx";

// Pages and Users render in the Sessions toolbar slot above the scroller, so every
// panel header keeps one geometry, stays pinned, and clears the scrollbar gutter.

export function SidebarPagesHeader(props: { host: AppSidebarRenderHost }) {
  return (
    <div class="sidebar-panel-header" onMouseDown={beginNativeWindowDrag}>
      <span class="sidebar-panel-header__title">{t("nav.pages")}</span>
      <SidebarCollapseToggle onToggle={() => props.host.onToggleSidebar?.()} />
    </div>
  );
}

export function SidebarOnlineHeader(props: { host: AppSidebarRenderHost }) {
  const mobile = createMediaQuery(mobileNavLayoutMediaQuery(), isMobileNavLayout());
  const filtered = createMemo(
    () =>
      props.host.people.statusFilter === "running" ||
      (!mobile() && props.host.people.presenceFilter === "all"),
  );
  return (
    <div class="sidebar-panel-header" onMouseDown={beginNativeWindowDrag}>
      <Show
        when={mobile()}
        fallback={<span class="sidebar-panel-header__title">{t("presence.usersTitle")}</span>}
      >
        <Picker
          id="sidebar-people-presence"
          class="sidebar-session-owner-filter"
          triggerIcon="chevronsUpDown"
          label={t("presence.usersTitle")}
          value={props.host.people.presenceFilter}
          sheet
          showOptionTooltips={false}
          options={[
            { value: "online", label: t("presence.rosterTitle") },
            { value: "all", label: t("presence.allUsers") },
          ]}
          onChange={(value) => {
            if (value === "online" || value === "all") {
              props.host.people.set("presenceFilter", value);
            }
          }}
        />
      </Show>
      <button
        type="button"
        class={[
          "sidebar-session-toolbar__button sidebar-online__filter-toggle sidebar-session-sort",
          { "sidebar-session-sort--filtered": filtered() },
        ]}
        aria-label={t("presence.filters.label")}
        title={t("presence.filters.label")}
        aria-haspopup="dialog"
        aria-expanded={props.host.sidebarMenus.peopleFilterMenuPosition !== null ? "true" : "false"}
        onClick={(event: MouseEvent) => {
          if (event.currentTarget instanceof HTMLElement) {
            props.host.sidebarMenus.togglePositionedMenu("peopleFilter", event.currentTarget);
          }
        }}
      >
        <Icon name="listFilter" />
      </button>
      <SidebarCollapseToggle onToggle={() => props.host.onToggleSidebar?.()} />
    </div>
  );
}
