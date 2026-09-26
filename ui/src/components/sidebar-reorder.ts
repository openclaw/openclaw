import { html } from "lit";
import { t } from "../i18n/index.ts";
import "../styles/sidebar-reorder.css";
import { icons } from "./icons.ts";
import "./web-awesome.ts";

type ReorderPosition = "before" | "after";

export function renderSidebarReorderMenu(params: {
  label: string;
  kind: "entry" | "section";
  onMove: (target: string, position: ReorderPosition) => void | Promise<void>;
}) {
  const attribute = params.kind === "entry" ? "data-sidebar-entry" : "data-session-section";
  const adjacent = (menu: HTMLElement, position: ReorderPosition): string | null => {
    const row = menu.closest(`[${attribute}]`);
    const siblings = [...(row?.parentElement?.children ?? [])].filter(
      (element) =>
        element.hasAttribute(attribute) &&
        (params.kind === "entry" ||
          element.querySelector('.sidebar-recent-sessions__head[draggable="true"]')),
    );
    const index = row ? siblings.indexOf(row) : -1;
    return index < 0
      ? null
      : (siblings[index + (position === "before" ? -1 : 1)]?.getAttribute(attribute) ?? null);
  };
  const label = t("chat.sidebar.reorderItem", { item: params.label });
  return html`
    <wa-dropdown
      class="sidebar-reorder-menu"
      placement="bottom-end"
      aria-label=${label}
      @wa-show=${(event: Event) => {
        const menu = event.currentTarget;
        if (!(menu instanceof HTMLElement)) {
          return;
        }
        for (const position of ["before", "after"] as const) {
          menu
            .querySelector(`wa-dropdown-item[value="${position}"]`)
            ?.toggleAttribute("disabled", adjacent(menu, position) === null);
        }
      }}
      @wa-select=${async (event: CustomEvent<{ item: { value?: string } }>) => {
        const position = event.detail.item.value;
        if (position !== "before" && position !== "after") {
          return;
        }
        const menu = event.currentTarget;
        if (!(menu instanceof HTMLElement)) {
          return;
        }
        const target = adjacent(menu, position);
        if (target) {
          const trigger = menu.querySelector<HTMLButtonElement>("button[slot=trigger]");
          await params.onMove(target, position);
          // Moving a keyed DOM row can drop focus; do not reclaim it from another control.
          if (trigger?.isConnected && document.activeElement === document.body) {
            trigger.focus({ preventScroll: true });
          }
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="sidebar-reorder-trigger"
        aria-label=${label}
        title=${label}
      >
        ${icons.gripVertical}
      </button>
      <wa-dropdown-item value="before">
        <span slot="icon" aria-hidden="true">${icons.arrowUp}</span>
        ${t("chat.sidebar.moveUp")}
      </wa-dropdown-item>
      <wa-dropdown-item value="after">
        <span slot="icon" aria-hidden="true">${icons.arrowDown}</span>
        ${t("chat.sidebar.moveDown")}
      </wa-dropdown-item>
    </wa-dropdown>
  `;
}
