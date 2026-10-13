import { For, onSettled } from "solid-js";
import { copyToClipboard } from "../lib/clipboard.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { connectDropdownMenu } from "./dropdown-menu-controller.ts";
import { activateMenuShortcut } from "./menu-shortcuts.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import { Icon } from "./solid/icon.tsx";
import { Kbd } from "./solid/kbd.tsx";
import { resolveTransientContainer } from "./transient-container.ts";
import "./web-awesome.ts";

type NativeLinkMenuAction = "inline" | "external" | "copy";
type Props = {
  x: number;
  y: number;
  trigger: HTMLAnchorElement | null;
  onAction: (action: NativeLinkMenuAction) => void;
  onClose: () => void;
};
export type NativeLinkMenu = SolidBridgeElement<Props>;

export const NativeLinkMenu = defineSolidBridge<Props>(
  "openclaw-native-link-menu",
  (props, host) => {
    const items = [
      ["inline", "s", "openInline", "panelRightOpen"],
      ["external", "b", "openExternal", "externalLink"],
      ["copy", "c", "copy", "copy"],
    ] as const;
    onSettled(() =>
      connectDropdownMenu(
        host,
        {
          getTrigger: () => props.trigger,
          onClose: () => props.onClose(),
          onKeydown: (event) => activateMenuShortcut(host, event),
        },
        () => host.updateComplete,
      ),
    );
    return (
      <wa-dropdown
        class="session-menu native-link-menu"
        prop:open={true}
        placement="bottom-start"
        prop:distance={0}
        aria-label={t("nativeLinkMenu.label")}
        onWa-select={(event) => {
          event.preventDefault();
          const action = event.detail.item.value;
          if (action === "inline" || action === "external" || action === "copy") {
            props.trigger?.focus();
            props.onClose();
            props.onAction(action);
          }
        }}
        onWa-after-hide={() => props.onClose()}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label={t("nativeLinkMenu.label")}
          style={{
            position: "fixed",
            left: `${Math.max(8, Math.min(props.x, window.innerWidth - 264 - 8))}px`,
            top: `${Math.max(8, Math.min(props.y, window.innerHeight - 136 - 8))}px`,
            width: "1px",
            height: "1px",
            opacity: 0,
            "pointer-events": "none",
          }}
        />
        <For each={items}>
          {([action, shortcut, label, icon]) => (
            <>
              {action === "copy" && <div class="session-menu__separator" role="separator" />}
              <wa-dropdown-item
                class="session-menu__item"
                value={action}
                data-new-tab-action={action === "external" ? "" : undefined}
                data-shortcut={shortcut}
                aria-keyshortcuts={shortcut.toUpperCase()}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">
                  <Icon name={icon} />
                </span>
                <span class="session-menu__text">{t(`nativeLinkMenu.${label}`)}</span>
                <span slot="details" class="session-menu__shortcut" aria-hidden="true">
                  <Kbd keys={shortcut.toUpperCase()} inline />
                </span>
              </wa-dropdown-item>
            </>
          )}
        </For>
      </wa-dropdown>
    );
  },
  {
    properties: {
      x: { default: 0, attribute: false },
      y: { default: 0, attribute: false },
      trigger: { default: null, attribute: false },
      onAction: { default: () => {}, attribute: false },
      onClose: { default: () => {}, attribute: false },
    },
  },
);

/** Native-only menu placement and actions load with the menu, not the browser shell. */
export function mountNativeLinkMenu(options: {
  path: EventTarget[];
  anchor: HTMLAnchorElement;
  url: URL;
  x: number;
  y: number;
  close: (expected: NativeLinkMenu) => void;
  openExternal: () => void;
  openInline: () => void;
}): NativeLinkMenu | null {
  const container = resolveTransientContainer(options.path, options.anchor.ownerDocument);
  if (!container?.isConnected) {
    return null;
  }
  const menu = document.createElement("openclaw-native-link-menu");
  menu.x = options.x;
  menu.y = options.y;
  menu.trigger = options.anchor;
  menu.onClose = () => options.close(menu);
  menu.onAction = (action) => {
    if (action === "copy") {
      void copyToClipboard(options.url.href);
    } else if (action === "inline") {
      options.openInline();
    } else {
      options.openExternal();
    }
  };
  container.append(menu);
  promoteToPopoverTopLayer(menu);
  return menu;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-native-link-menu": NativeLinkMenu;
  }
}
