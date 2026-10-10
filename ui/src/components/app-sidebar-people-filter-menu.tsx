import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.tsx";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
import { renderPicker } from "./solid/select-picker.tsx";

const SORT_OPTIONS = [
  { value: "presence", labelKey: "presence.filters.presence" },
  { value: "running", labelKey: "presence.filters.running" },
  { value: "open", labelKey: "presence.filters.total" },
  { value: "name", labelKey: "presence.filters.name" },
] as const;

export function renderSidebarPeopleFilterMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const position = controller.peopleFilterMenuPosition;
  if (!position) {
    return undefined;
  }
  const people = createMemo(() => controller.host.people);
  const commit = (update: () => void) => {
    if (controller.peopleFilterMenuPosition !== position) {
      return;
    }
    update();
    controller.closePositionedMenu("peopleFilter", { restoreFocus: true });
  };
  const sheet = createMemo(() => isMobileNavLayout());
  const changed = createMemo(
    () => people().statusFilter !== "all" || people().sortMode !== "presence",
  );
  return (
    <Show when={position} keyed>
      {(_identity) => (
        <SidebarSessionFilterPopover
          class="sidebar-session-sort-menu sidebar-people-filter-menu"
          anchor={controller.peopleFilterMenuTrigger}
          label={t("presence.filters.label")}
          initialFocusSelector={"#sidebar-people-status"}
          onClose={controller.positionedMenuHandlers("peopleFilter").onClose}
          content={
            <>
              <div class="sidebar-session-menu-section">
                {renderPicker({
                  id: "sidebar-people-status",
                  get label() {
                    return t("sessionsView.status");
                  },
                  get value() {
                    return people().statusFilter;
                  },
                  variant: "submenu",
                  get sheet() {
                    return sheet();
                  },
                  showOptionTooltips: false,
                  get options() {
                    return [
                      { value: "all", label: t("sessionsView.all") },
                      { value: "running", label: t("common.running") },
                    ];
                  },
                  onChange: (value) => {
                    if (value === "all" || value === "running") {
                      commit(() => people().setStatusFilter(value));
                    }
                  },
                })}
                {renderPicker({
                  id: "sidebar-people-sort",
                  get label() {
                    return t("chat.sidebar.sortBy");
                  },
                  get value() {
                    return people().sortMode;
                  },
                  variant: "submenu",
                  get sheet() {
                    return sheet();
                  },
                  showOptionTooltips: false,
                  get options() {
                    return SORT_OPTIONS.map((option) => ({
                      value: option.value,
                      label: t(option.labelKey),
                    }));
                  },
                  onChange: (value) => {
                    const option = SORT_OPTIONS.find((entry) => entry.value === value);
                    if (option) {
                      commit(() => people().setSortMode(option.value));
                    }
                  },
                })}
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
      )}
    </Show>
  );
}
