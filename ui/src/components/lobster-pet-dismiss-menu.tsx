import { createUniqueId, onCleanup } from "solid-js";
import { t } from "../i18n/index.ts";
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
  let returnTarget: HTMLElement | undefined;
  let removeListeners: (() => void) | undefined;
  onCleanup(() => removeListeners?.());
  const restoreCapturedFocus = () => {
    const trigger = menu.overlay.trigger;
    if (!trigger || !returnTarget?.isConnected) {
      return;
    }
    const root = trigger.getRootNode();
    const active =
      root instanceof ShadowRoot ? root.activeElement : trigger.ownerDocument.activeElement;
    // Translate only the owner's trigger focus; outside interactions keep their target.
    if (active === trigger) {
      returnTarget.focus({ preventScroll: true });
    }
  };
  return (
    <div
      class="lobster-pet-dismiss-menu__position"
      style={`--lobster-pet-menu-x: ${params.position.x}px; --lobster-pet-menu-y: ${params.position.y}px;`}
    >
      <Menu
        id={id}
        class="session-menu lobster-pet-dismiss-menu"
        panelClass="lobster-pet-dismiss-menu__panel"
        triggerClass="lobster-pet-dismiss-menu__trigger"
        ref={(handle) => {
          menu = handle;
          // Menu binds its trigger before ref; it is only a hidden point anchor here.
          const trigger = handle.overlay.trigger!;
          trigger.tabIndex = -1;
          trigger.setAttribute("aria-hidden", "true");
          const root = trigger.getRootNode();
          const active =
            root instanceof ShadowRoot ? root.activeElement : trigger.ownerDocument.activeElement;
          returnTarget = active instanceof HTMLElement ? active : undefined;
          const surface = handle.overlay.surface;
          const close = () => params.onClose();
          surface.addEventListener("overlay-after-hide", close);
          trigger.addEventListener("focus", restoreCapturedFocus);
          removeListeners = () => {
            surface.removeEventListener("overlay-after-hide", close);
            trigger.removeEventListener("focus", restoreCapturedFocus);
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
