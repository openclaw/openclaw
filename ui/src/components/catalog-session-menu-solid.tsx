import { For, onCleanup, onSettled, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { connectDropdownMenu } from "./dropdown-menu-controller.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import { Icon, type IconName } from "./solid/icon.tsx";
import "./web-awesome.ts";

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

defineSolidBridge<Props>(
  "openclaw-catalog-session-menu",
  (props, host) => {
    onSettled(() => promoteToPopoverTopLayer(host));
    const disconnect = connectDropdownMenu(
      host,
      { getTrigger: () => props.trigger, onClose: () => props.onClose() },
      () => host.updateComplete,
    );
    onCleanup(disconnect);
    const label = () => t("chat.catalog.sessionMenu");
    return (
      <wa-dropdown
        class="session-menu"
        prop:open={true}
        placement="bottom-start"
        prop:distance={0}
        aria-label={label()}
        onWa-select={(event) => {
          event.preventDefault();
          const action = actions.find(([value]) => value === event.detail.item.value)?.[0];
          if (action) {
            // Capture the action before closing clears the caller's menu snapshot.
            props.onAction(action);
            props.onClose();
          }
        }}
        onWa-after-hide={(event) => {
          if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
            props.onClose();
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          tabindex={-1}
          aria-hidden="true"
          aria-label={label()}
          style={{
            position: "fixed",
            left: `${Math.max(8, Math.min(props.x, window.innerWidth - 248))}px`,
            top: `${Math.max(8, Math.min(props.y, window.innerHeight - 148 - (props.canDelete ? 40 : 0) - (props.canImport ? 40 : 0)))}px`,
            width: "1px",
            height: "1px",
            opacity: "0",
            "pointer-events": "none",
          }}
        />
        <Show when={props.lastActive}>
          <div class="session-menu__info">
            {t("sessionsView.lastActive", { time: props.lastActive })}
          </div>
        </Show>
        <For each={actions}>
          {([action, key, icon]) => (
            <Show
              when={
                action === "import" ? props.canImport : action === "delete" ? props.canDelete : true
              }
            >
              <wa-dropdown-item
                class={[
                  "session-menu__item",
                  { "session-menu__item--destructive": action === "delete" },
                ]}
                variant={action === "delete" ? "danger" : undefined}
                value={action}
                title={
                  action === "terminal" && props.terminalDisabled
                    ? t("chat.catalog.terminalUnavailable")
                    : undefined
                }
                disabled={action === "terminal" && props.terminalDisabled}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">
                  <Icon name={icon} />
                </span>
                <span class="session-menu__text">{t(key)}</span>
              </wa-dropdown-item>
            </Show>
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
      lastActive: { default: "", attribute: false },
      terminalDisabled: { default: false, attribute: false },
      canDelete: { default: false, attribute: false },
      canImport: { default: false, attribute: false },
      onAction: { default: () => {}, attribute: false },
      onClose: { default: () => {}, attribute: false },
    },
  },
);
