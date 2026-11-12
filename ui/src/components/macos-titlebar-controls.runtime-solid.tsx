import { Show } from "solid-js";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  type KeyboardShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { Icon, type IconName } from "./solid/icon.tsx";
import { ShortcutHint } from "./solid/kbd.tsx";
import "./tooltip.ts";

type Props = {
  historyOnly: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  macNavigation: boolean;
  navigationExpanded: boolean;
  onToggleSidebar: (() => void) | undefined;
  onOpenPalette: (() => void) | undefined;
};

function TitlebarButton(props: {
  label: string;
  icon: IconName;
  disabled?: boolean;
  expanded?: boolean;
  shortcut?: KeyboardShortcutCombo;
  onClick?: () => void;
  class: string;
}) {
  return (
    <openclaw-tooltip prop:content={props.label}>
      <Show when={props.shortcut}>
        {(combo) => (
          <span slot="content">
            <ShortcutHint label={props.label} combo={combo()} />
          </span>
        )}
      </Show>
      <button
        type="button"
        class={["topbar-icon-btn macos-titlebar-controls__button", props.class]}
        aria-label={props.label}
        aria-expanded={props.expanded === undefined ? undefined : props.expanded ? "true" : "false"}
        disabled={props.disabled || !props.onClick}
        onClick={() => props.onClick?.()}
      >
        <Icon name={props.icon} />
      </button>
    </openclaw-tooltip>
  );
}

export const MacosTitlebarControls = defineSolidBridge<Props>(
  "openclaw-macos-titlebar-controls",
  (props, host) => {
    host.style.display = "contents";
    return (
      <nav
        class={[
          "macos-titlebar-controls",
          {
            "macos-titlebar-controls--history-only": props.historyOnly,
          },
        ]}
        onMouseDown={beginNativeWindowDrag}
      >
        <Show when={props.macNavigation}>
          <TitlebarButton
            label={t(props.navigationExpanded ? "nav.collapse" : "nav.expand")}
            icon="sessionPanels"
            expanded={props.navigationExpanded}
            disabled={props.historyOnly}
            onClick={props.onToggleSidebar}
            class="macos-titlebar-controls__sidebar"
          />
          <TitlebarButton
            label={t("chat.openCommandPalette")}
            icon="search"
            shortcut={KEYBOARD_SHORTCUT_COMBOS.commandPalette}
            onClick={props.onOpenPalette}
            class="macos-titlebar-controls__search"
          />
        </Show>
        <TitlebarButton
          label={t("nav.back")}
          icon="chevronLeft"
          disabled={!props.canGoBack}
          onClick={() => globalThis.history.back()}
          class="macos-titlebar-controls__back"
        />
        <TitlebarButton
          label={t("nav.forward")}
          icon="chevronRight"
          disabled={!props.canGoForward}
          onClick={() => globalThis.history.forward()}
          class="macos-titlebar-controls__forward"
        />
      </nav>
    );
  },
  {
    properties: {
      historyOnly: { default: false, attribute: false },
      canGoBack: { default: false, attribute: false },
      canGoForward: { default: false, attribute: false },
      macNavigation: { default: false, attribute: false },
      navigationExpanded: { default: false, attribute: false },
      onToggleSidebar: { default: undefined, attribute: false },
      onOpenPalette: { default: undefined, attribute: false },
    },
  },
);
