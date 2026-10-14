import { createSignal, createUniqueId, flush } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import "../styles/sidebar-reorder.css";
import { Icon } from "./solid/icon.tsx";
import { Menu, type MenuHandle, type MenuItem } from "./solid/menu.tsx";

type ReorderPosition = "before" | "after";
export function renderSidebarReorderMenu(params: {
  label: string;
  onMove: (target: string, position: ReorderPosition) => void | Promise<void>;
}) {
  let handle: MenuHandle | undefined;
  const [revision, refresh] = createSignal(0);
  const attribute = "data-session-section";
  const adjacent = (position: ReorderPosition): string | null => {
    const row = handle?.overlay.trigger?.closest(`[${attribute}]`);
    const siblings = [...(row?.parentElement?.children ?? [])].filter(
      (element) =>
        element.hasAttribute(attribute) &&
        element.querySelector('.sidebar-recent-sessions__head[draggable="true"]'),
    );
    const index = row ? siblings.indexOf(row) : -1;
    return index < 0
      ? null
      : (siblings[index + (position === "before" ? -1 : 1)]?.getAttribute(attribute) ?? null);
  };
  const items: MenuItem[] = (["before", "after"] as const).map((position) => ({
    id: position,
    label: t(position === "before" ? "chat.sidebar.moveUp" : "chat.sidebar.moveDown"),
    get disabled() {
      revision();
      return adjacent(position) === null;
    },
    icon: <Icon name={position === "before" ? "arrowUp" : "arrowDown"} />,
  }));
  const label = () => t("chat.sidebar.reorderItem", { item: params.label });
  return (
    <Menu
      id={`sidebar-reorder-${createUniqueId()}`}
      class="sidebar-reorder-menu"
      placement="bottom-end"
      label={label()}
      items={items}
      triggerClass="sidebar-reorder-trigger"
      triggerAttributes={{ title: label() }}
      trigger={<Icon name="gripVertical" />}
      ref={(value) => {
        handle = value;
        value.overlay.surface.dataset.chatAutotypeExempt = "";
      }}
      onBeforeShow={() => {
        // Keyed rows move without remounting; refresh all Zag bindings before opening.
        refresh((value) => value + 1);
        flush();
      }}
      onSelect={(item) => {
        const position = item.id;
        if (position !== "before" && position !== "after") {
          return;
        }
        const target = adjacent(position);
        const trigger = handle?.overlay.trigger;
        if (target) {
          void Promise.resolve(params.onMove(target, position)).then(() => {
            // Moving a keyed DOM row can drop focus; do not reclaim it from another control.
            if (trigger?.isConnected && document.activeElement === document.body) {
              trigger.focus({ preventScroll: true });
            }
          });
        }
      }}
    />
  );
}
