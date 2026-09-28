import { html } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { DropdownMenuController } from "./dropdown-menu-controller.ts";
import { icons } from "./icons.ts";
import { activateMenuShortcut, menuShortcutHint } from "./menu-shortcuts.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import "./web-awesome.ts";

export type NativeLinkMenuAction = "inline" | "external" | "copy";

export class NativeLinkMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) x = 0;
  @property({ attribute: false }) y = 0;
  @property({ attribute: false }) trigger: HTMLAnchorElement | null = null;
  @property({ attribute: false }) onAction: (action: NativeLinkMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  readonly menuLifecycle = new DropdownMenuController(this, {
    getTrigger: () => this.trigger,
    onClose: () => this.onClose(),
    onKeydown: (event) => activateMenuShortcut(this, event),
  });

  private runAction(action: NativeLinkMenuAction) {
    this.onClose();
    this.onAction(action);
  }

  override render() {
    const menuWidth = 264;
    const menuMaxHeight = 136;
    const clampedX = Math.max(8, Math.min(this.x, window.innerWidth - menuWidth - 8));
    const clampedY = Math.max(8, Math.min(this.y, window.innerHeight - menuMaxHeight - 8));
    return html`
      <wa-dropdown
        class="session-menu native-link-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${t("nativeLinkMenu.label")}
        @wa-select=${(event: CustomEvent<{ item: { value?: NativeLinkMenuAction } }>) => {
          event.preventDefault();
          const action = event.detail.item.value;
          if (action) {
            this.trigger?.focus();
            this.runAction(action);
          }
        }}
        @wa-after-hide=${() => {
          this.onClose();
        }}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${t("nativeLinkMenu.label")}
          style="position: fixed; left: ${clampedX}px; top: ${clampedY}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        <wa-dropdown-item
          class="session-menu__item"
          value="inline"
          data-shortcut="s"
          aria-keyshortcuts="S"
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${icons.panelRightOpen}</span
          >
          <span class="session-menu__text">${t("nativeLinkMenu.openInline")}</span>
          ${menuShortcutHint("s")}
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item"
          value="external"
          data-new-tab-action
          data-shortcut="b"
          aria-keyshortcuts="B"
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${icons.externalLink}</span
          >
          <span class="session-menu__text">${t("nativeLinkMenu.openExternal")}</span>
          ${menuShortcutHint("b")}
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item
          class="session-menu__item"
          value="copy"
          data-shortcut="c"
          aria-keyshortcuts="C"
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
          <span class="session-menu__text">${t("nativeLinkMenu.copy")}</span>
          ${menuShortcutHint("c")}
        </wa-dropdown-item>
      </wa-dropdown>
    `;
  }
}

function menuContainer(path: EventTarget[]): HTMLElement {
  const modalHost = path.find(
    (target) => target instanceof HTMLElement && target.localName === "openclaw-modal-dialog",
  );
  if (modalHost instanceof HTMLElement) {
    return modalHost;
  }
  for (const target of path) {
    if (target instanceof HTMLDialogElement && target.open && target.getRootNode() === document) {
      return target;
    }
  }
  return document.body;
}

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
  const container = menuContainer(options.path);
  if (!container.isConnected) {
    return null;
  }
  // SAFETY: This module registers the tag; createElement uses its retained constructor after HMR.
  const menu = document.createElement("openclaw-native-link-menu") as NativeLinkMenu;
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

if (!customElements.get("openclaw-native-link-menu")) {
  customElements.define("openclaw-native-link-menu", NativeLinkMenu);
}
