import { createUniqueId, onSettled } from "solid-js";
import { t } from "../i18n/index.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { JSX } from "../types/solid-elements.d.ts";
import { Menu, type MenuHandle } from "./solid/menu.tsx";

export type LobsterPetDismissMenuPosition = { x: number; y: number };

export function LobsterPetDismissMenu(params: {
  position: LobsterPetDismissMenuPosition;
  onDismiss: (permanently: boolean) => void;
  onClose: () => void;
}): JSX.Element {
  const id = createUniqueId();
  let menu!: MenuHandle;
  let removeListeners: (() => void) | undefined;
  // Menu supplies its handle during settled setup; this owner retires its listeners.
  onSettled(() => () => removeListeners?.());
  return (
    <div
      class="lobster-pet-dismiss-menu__position"
      style={{
        "--lobster-pet-menu-x": `${params.position.x}px`,
        "--lobster-pet-menu-y": `${params.position.y}px`,
      }}
    >
      <Menu
        id={id}
        class="session-menu lobster-pet-dismiss-menu"
        panelClass="lobster-pet-dismiss-menu__panel"
        triggerClass="lobster-pet-dismiss-menu__trigger"
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
        label={t("quickSettings.appearance.lobsterVisits")}
        items={[
          { id: "dismiss", label: t("common.dismiss"), class: "session-menu__item" },
          {
            id: "dismiss-permanently",
            label: t("common.dismissAndDontShowAgain"),
            class: "session-menu__item",
          },
        ]}
        onSelect={(item, event) => {
          event.preventDefault();
          // Restore focus through the owner before dismissal removes this menu.
          if (menu.close()) {
            params.onDismiss(item.id === "dismiss-permanently");
          }
        }}
      />
    </div>
  );
}
