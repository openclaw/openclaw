import { createUniqueId, onSettled } from "solid-js";
import type { ControlUiContextMenuProps } from "../../../src/plugin-sdk/control-ui-components.js";
import "./control-ui-context-menu.css";
import { Menu, type MenuHandle } from "../components/solid/menu.tsx";
import { listen } from "../lib/reactive/listener.ts";
import type { JSX } from "../types/solid-elements.d.ts";

export default function ContextMenu(params: ControlUiContextMenuProps): JSX.Element {
  const id = createUniqueId();
  let menu!: MenuHandle;
  let removeListeners: (() => void) | undefined;
  // Menu supplies its handle during settled setup; this owner retires its listeners.
  onSettled(() => () => removeListeners?.());
  return (
    <div
      class="plugin-context-dismiss-menu__position"
      style={{
        "--plugin-context-menu-x": `${params.position.x}px`,
        "--plugin-context-menu-y": `${params.position.y}px`,
      }}
    >
      <Menu
        id={id}
        class="session-menu plugin-context-dismiss-menu"
        panelClass="plugin-context-dismiss-menu__panel"
        triggerClass="plugin-context-dismiss-menu__trigger"
        triggerAttributes={{ tabindex: -1, "aria-hidden": "true" }}
        ref={(handle) => {
          menu = handle;
          const trigger = handle.overlay.trigger!;
          const root = trigger.getRootNode();
          const active =
            root instanceof ShadowRoot ? root.activeElement : trigger.ownerDocument.activeElement;
          const stopClose = listen(handle.overlay.surface, "overlay-after-hide", () =>
            params.onClose(),
          );
          // setReturnTarget would incorrectly count this outside element as inside the menu.
          const stopFocus = listen(trigger, "focus", () => {
            const focusRoot = trigger.getRootNode();
            const focused =
              focusRoot instanceof ShadowRoot
                ? focusRoot.activeElement
                : trigger.ownerDocument.activeElement;
            if (focused === trigger && active instanceof HTMLElement && active.isConnected) {
              active.focus({ preventScroll: true });
            }
          });
          removeListeners = () => {
            stopClose();
            stopFocus();
          };
          if (!handle.open()) {
            params.onClose();
          }
        }}
        placement="top-start"
        label={params.label}
        items={params.items.map((item) => ({ ...item, class: "session-menu__item" }))}
        onSelect={(item, event) => {
          event.preventDefault();
          // Restore focus through the owner before dismissal removes this menu.
          if (menu.close()) {
            params.onSelect(item.id);
          }
        }}
      />
    </div>
  );
}
