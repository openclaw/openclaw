import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { t } from "../i18n/index.ts";
import { renderPicker } from "./select-picker.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";
import "./sidebar-session-filter-popover.ts";

const SORT_OPTIONS = [
  { value: "presence", labelKey: "presence.filters.presence" },
  { value: "running", labelKey: "presence.filters.running" },
  { value: "open", labelKey: "presence.filters.total" },
  { value: "name", labelKey: "presence.filters.name" },
] as const;

export function renderSidebarPeopleFilterMenuForController(controller: SidebarMenusController) {
  const position = controller.peopleFilterMenuPosition;
  if (!position) {
    return nothing;
  }
  const people = controller.host.people;
  const commit = (update: () => void) => {
    if (controller.peopleFilterMenuPosition !== position) {
      return;
    }
    update();
    controller.closePositionedMenu("peopleFilter", { restoreFocus: true });
  };
  const sheet = isMobileNavLayout();
  const changed = people.statusFilter !== "all" || people.sortMode !== "presence";
  return keyed(
    position,
    html`<openclaw-sidebar-session-filter-popover
      class="sidebar-session-sort-menu sidebar-people-filter-menu"
      .anchor=${controller.peopleFilterMenuTrigger}
      .label=${t("presence.filters.label")}
      .initialFocusSelector=${"#sidebar-people-status"}
      .onClose=${(restoreFocus: boolean) => {
        if (controller.peopleFilterMenuPosition === position) {
          controller.closePositionedMenu("peopleFilter", { restoreFocus });
        }
      }}
      .content=${html`
        <div class="sidebar-session-menu-section">
          ${renderPicker({
            id: "sidebar-people-status",
            label: t("sessionsView.status"),
            value: people.statusFilter,
            variant: "submenu",
            sheet,
            showOptionTooltips: false,
            options: [
              { value: "all", label: t("sessionsView.all") },
              { value: "running", label: t("common.running") },
            ],
            onChange: (value) => {
              if (value === "all" || value === "running") {
                commit(() => people.setStatusFilter(value));
              }
            },
          })}
          ${renderPicker({
            id: "sidebar-people-sort",
            label: t("chat.sidebar.sortBy"),
            value: people.sortMode,
            variant: "submenu",
            sheet,
            showOptionTooltips: false,
            options: SORT_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            })),
            onChange: (value) => {
              const option = SORT_OPTIONS.find((entry) => entry.value === value);
              if (option) {
                commit(() => people.setSortMode(option.value));
              }
            },
          })}
        </div>
        ${
          changed
            ? html`<footer class="sidebar-session-menu-footer">
                <button
                  type="button"
                  id="sidebar-people-reset"
                  class="sidebar-session-filter-footer"
                  @click=${() => commit(() => people.resetView())}
                >
                  ${t("presence.filters.reset")}
                </button>
              </footer>`
            : nothing
        }
      `}
    ></openclaw-sidebar-session-filter-popover>`,
  );
}
