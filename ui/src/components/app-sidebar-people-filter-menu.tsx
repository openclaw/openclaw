import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
import { Picker } from "./solid/select-picker.tsx";

const SORT_OPTIONS = [
  { value: "presence", labelKey: "presence.filters.presence" },
  { value: "running", labelKey: "presence.filters.running" },
  { value: "open", labelKey: "presence.filters.total" },
  { value: "name", labelKey: "presence.filters.name" },
] as const;

export function renderSidebarPeopleFilterMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  position: NonNullable<SidebarMenus["peopleFilterMenuPosition"]>,
): JSX.Element {
  const people = () => host.people;
  const commit = (update: () => void) => {
    if (menus.peopleFilterMenuPosition !== position) {
      return;
    }
    update();
    menus.closePositionedMenu("peopleFilter", { restoreFocus: true });
  };
  const sheet = () => isMobileNavLayout();
  const changed = createMemo(
    () => people().statusFilter !== "all" || people().sortMode !== "presence",
  );
  return (
    <SidebarSessionFilterPopover
      class="sidebar-session-sort-menu sidebar-people-filter-menu"
      anchor={menus.triggers.get("peopleFilter") ?? null}
      label={t("presence.filters.label")}
      initialFocusSelector="#sidebar-people-status"
      onClose={menus.positionedMenuHandlers("peopleFilter").onClose}
      content={
        <>
          <div class="sidebar-session-menu-section">
            <Picker
              id="sidebar-people-status"
              label={t("sessionsView.status")}
              value={people().statusFilter}
              variant="submenu"
              sheet={sheet()}
              showOptionTooltips={false}
              options={[
                { value: "all", label: t("sessionsView.all") },
                { value: "running", label: t("common.running") },
              ]}
              onChange={(value) => {
                if (value === "all" || value === "running") {
                  commit(() => people().set("statusFilter", value));
                }
              }}
            />
            <Picker
              id="sidebar-people-sort"
              label={t("chat.sidebar.sortBy")}
              value={people().sortMode}
              variant="submenu"
              sheet={sheet()}
              showOptionTooltips={false}
              options={SORT_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              onChange={(value) => {
                const option = SORT_OPTIONS.find((entry) => entry.value === value);
                if (option) {
                  commit(() => people().set("sortMode", option.value));
                }
              }}
            />
          </div>
          {changed() ? (
            <footer class="sidebar-session-menu-footer">
              <button
                type="button"
                id="sidebar-people-reset"
                class="sidebar-session-filter-footer"
                onClick={() => commit(() => people().resetView())}
              >
                {t("presence.filters.reset")}
              </button>
            </footer>
          ) : undefined}
        </>
      }
    />
  );
}
