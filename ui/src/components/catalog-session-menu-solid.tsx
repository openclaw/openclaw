import { createEffect, createMemo, createUniqueId, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { Icon, type IconName } from "./solid/icon.tsx";
import { pointMenuTriggerAttributes } from "./solid/menu-trigger.tsx";
import { Menu, type MenuHandle, type MenuItem } from "./solid/menu.tsx";

export type CatalogSessionMenuAction = "viewer" | "import" | "terminal" | "delete";
type Props = {
  x: number;
  y: number;
  trigger: HTMLElement | null;
  lastActive: string;
  terminalDisabled: boolean;
  canDelete: boolean;
  canImport: boolean;
  onAction: (action: CatalogSessionMenuAction) => void;
  onClose: () => void;
};
const actions: readonly [CatalogSessionMenuAction, string, IconName][] = [
  ["viewer", "chat.catalog.openInOpenClaw", "messageSquare"],
  ["import", "chat.catalog.importToOpenClaw", "download"],
  ["terminal", "chat.catalog.openInTerminal", "terminal"],
  ["delete", "chat.catalog.deleteSession", "trash"],
];

export const CatalogSessionMenu = defineSolidBridge<Props>(
  "openclaw-catalog-session-menu",
  (props, host) => {
    const id = createUniqueId();
    let menu: MenuHandle | undefined;
    createEffect(
      () => props.trigger,
      (trigger) => {
        if (trigger) {
          menu?.overlay.setReturnTarget(trigger);
        }
      },
    );
    const label = () => t("chat.catalog.sessionMenu");
    // Queued menu selections must reuse JSX descriptors created under this owner.
    const items = createMemo<MenuItem[]>(() =>
      actions
        .filter(([action]) =>
          action === "import" ? props.canImport : action === "delete" ? props.canDelete : true,
        )
        .map(([action, key, icon]) => ({
          id: action,
          label: t(key),
          class: `session-menu__item${action === "delete" ? " session-menu__item--destructive" : ""}`,
          variant: action === "delete" ? "danger" : undefined,
          disabled: action === "terminal" && props.terminalDisabled,
          attributes: {
            title:
              action === "terminal" && props.terminalDisabled
                ? t("chat.catalog.terminalUnavailable")
                : undefined,
          },
          icon: (
            <span class="session-menu__icon" aria-hidden="true">
              <Icon name={icon} />
            </span>
          ),
          content: <span class="session-menu__text">{t(key)}</span>,
        })),
    );
    return (
      <Menu
        id={id}
        class="session-menu"
        panelClass="session-menu__panel"
        placement="bottom-start"
        label={label()}
        items={items()}
        ref={(handle) => {
          menu = handle;
          if (props.trigger) {
            handle.overlay.setReturnTarget(props.trigger);
          }
          handle.open();
        }}
        onSelect={(item) => {
          const action = actions.find(([value]) => value === item.id)?.[0];
          if (action) {
            // Capture the action before closing clears the caller's menu snapshot.
            props.onAction(action);
            if (!host.isConnected) {
              props.onClose();
            }
          }
        }}
        onOpenChange={(open) => {
          if (!open && host.isConnected) {
            props.onClose();
          }
        }}
        triggerAttributes={pointMenuTriggerAttributes({
          x: Math.max(8, Math.min(props.x, window.innerWidth - 248)),
          y: Math.max(
            8,
            Math.min(
              props.y,
              window.innerHeight - 148 - (props.canDelete ? 40 : 0) - (props.canImport ? 40 : 0),
            ),
          ),
        })}
      >
        <Show when={props.lastActive}>
          <div class="session-menu__info">
            {t("sessionsView.lastActive", { time: props.lastActive })}
          </div>
        </Show>
      </Menu>
    );
  },
  {
    properties: {
      x: { default: 0, attribute: false },
      y: { default: 0, attribute: false },
      trigger: { default: null, attribute: false },
      lastActive: { default: "", attribute: false },
      terminalDisabled: { default: false, attribute: false },
      canDelete: { default: false, attribute: false },
      canImport: { default: false, attribute: false },
      onAction: { default: () => {}, attribute: false },
      onClose: { default: () => {}, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-catalog-session-menu": SolidBridgeElement<Props>;
  }
}
