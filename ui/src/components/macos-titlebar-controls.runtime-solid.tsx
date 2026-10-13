import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { Icon, type IconName } from "./solid/icon.tsx";
import { Kbd, KeyboardShortcut, ShortcutText } from "./solid/kbd.tsx";
import "./tooltip.ts";

type Props = {
  navCollapsed: boolean;
  historyOnly: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  newSessionDisabledReason: string | undefined;
  onToggleSidebar: (() => void) | undefined;
  onOpenPalette: (() => void) | undefined;
  onOpenNewSession: (() => void) | undefined;
};

function TitlebarButton(props: {
  label: string;
  tooltip?: string;
  tooltipContent?: JSX.Element;
  icon: IconName;
  disabled?: boolean;
  ariaExpanded?: boolean;
  onClick?: () => void;
  class: string;
}) {
  return (
    <openclaw-tooltip prop:content={props.tooltip ?? props.label}>
      <Show when={props.tooltipContent}>
        <span slot="content">{props.tooltipContent}</span>
      </Show>
      <button
        type="button"
        class={`topbar-icon-btn macos-titlebar-controls__button ${props.class}`}
        aria-label={props.label}
        aria-expanded={
          props.ariaExpanded === undefined ? undefined : props.ariaExpanded ? "true" : "false"
        }
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
      <nav class="macos-titlebar-controls" onMouseDown={beginNativeWindowDrag}>
        <Show when={!props.historyOnly}>
          <TitlebarButton
            label={props.navCollapsed ? t("nav.expand") : t("nav.collapse")}
            icon={props.navCollapsed ? "panelLeftOpen" : "panelLeftClose"}
            ariaExpanded={!props.navCollapsed}
            onClick={props.onToggleSidebar}
            class="macos-titlebar-controls__sidebar-toggle"
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
        <Show when={!props.historyOnly}>
          <TitlebarButton
            label={t("chat.openCommandPalette")}
            tooltip={t("chat.commandPaletteTitle")}
            tooltipContent={
              <ShortcutText
                text={t("chat.commandPaletteTitle").replace("⌘K", "{shortcut}")}
                shortcut={() => <Kbd keys={["⌘", "K"]} inline />}
              />
            }
            icon="search"
            onClick={props.onOpenPalette}
            class="macos-titlebar-controls__search"
          />
          <Show when={props.navCollapsed}>
            <TitlebarButton
              label={t("chat.runControls.newSession")}
              tooltip={
                props.newSessionDisabledReason ??
                `${t("chat.runControls.newSession")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.newSession)})`
              }
              tooltipContent={
                props.newSessionDisabledReason == null ? (
                  <>
                    {t("chat.runControls.newSession")}
                    {" ("}
                    <KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.newSession} inline />)
                  </>
                ) : undefined
              }
              icon="plus"
              disabled={Boolean(props.newSessionDisabledReason)}
              onClick={props.onOpenNewSession}
              class="macos-titlebar-controls__new-session"
            />
          </Show>
        </Show>
      </nav>
    );
  },
  {
    properties: {
      navCollapsed: { default: false, attribute: false },
      historyOnly: { default: false, attribute: false },
      canGoBack: { default: false, attribute: false },
      canGoForward: { default: false, attribute: false },
      newSessionDisabledReason: { default: undefined, attribute: false },
      onToggleSidebar: { default: undefined, attribute: false },
      onOpenPalette: { default: undefined, attribute: false },
      onOpenNewSession: { default: undefined, attribute: false },
    },
  },
);
