import { createMemo, createUniqueId } from "solid-js";
import { copyToClipboard } from "../lib/clipboard.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import { activateMenuShortcut } from "./menu-shortcut-activation.ts";
import { Icon } from "./solid/icon.tsx";
import { Kbd } from "./solid/kbd.tsx";
import { pointMenuTriggerAttributes } from "./solid/menu-trigger.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "./solid/menu.tsx";
import { resolveTransientContainer } from "./transient-container.ts";
import "./native-link-menu.css";

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
  (props) => {
    const id = createUniqueId();
    let menu: MenuHandle | undefined;
    const shortcut = nativeListener(
      "keydown",
      (event) => activateMenuShortcut(menu?.overlay.surface, event),
      true,
    );
    const actions = [
      ["inline", "s", "openInline", "panelRightOpen"],
      ["external", "b", "openExternal", "externalLink"],
      ["copy", "c", "copy", "copy"],
    ] as const;
    const items = createMemo((): MenuEntry[] =>
      actions.flatMap<MenuEntry>(([action, key, label, icon]) => {
        const item = {
          id: action,
          label: t(`nativeLinkMenu.${label}`),
          class: "session-menu__item",
          attributes: {
            "data-new-tab-action": action === "external" ? "" : undefined,
            "data-shortcut": key,
            "aria-keyshortcuts": key.toUpperCase(),
          },
          icon: (
            <span class="session-menu__icon" aria-hidden="true">
              <Icon name={icon} />
            </span>
          ),
          content: <span class="session-menu__text">{t(`nativeLinkMenu.${label}`)}</span>,
          details: (
            <span class="session-menu__shortcut" aria-hidden="true">
              <Kbd keys={key.toUpperCase()} inline />
            </span>
          ),
        };
        return action === "copy"
          ? [
              {
                kind: "content",
                id: "separator",
                content: <div class="session-menu__separator" role="separator" />,
              },
              item,
            ]
          : [item];
      }),
    );
    return (
      <Menu
        id={id}
        class="session-menu native-link-menu"
        panelClass="native-link-menu__panel"
        placement="bottom-start"
        label={t("nativeLinkMenu.label")}
        items={items()}
        ref={(handle) => {
          menu = handle;
          if (props.trigger) {
            handle.overlay.setReturnTarget(props.trigger);
          }
          shortcut(handle.overlay.surface);
          handle.open();
        }}
        onSelect={(item, event) => {
          event.preventDefault();
          const action = item.id;
          if (action === "inline" || action === "external" || action === "copy") {
            menu?.close();
            props.onAction(action);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            props.onClose();
          }
        }}
        triggerAttributes={pointMenuTriggerAttributes({
          x: Math.max(8, Math.min(props.x, window.innerWidth - 264 - 8)),
          y: Math.max(8, Math.min(props.y, window.innerHeight - 136 - 8)),
        })}
      />
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
  return menu;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-native-link-menu": NativeLinkMenu;
  }
}
