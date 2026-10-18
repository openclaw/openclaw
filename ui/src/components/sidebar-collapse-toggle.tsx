import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";
import "./tooltip.ts";

defineSolidBridge<{ onToggle?: () => void }>(
  "openclaw-sidebar-collapse-toggle",
  (props, host) => {
    host.style.display = "contents";
    return (
      <openclaw-tooltip
        prop:content={`${t("nav.collapse")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)})`}
      >
        <button
          type="button"
          class="sidebar-session-toolbar__button sidebar-session-toolbar__collapse"
          aria-label={t("nav.collapse")}
          aria-expanded="true"
          onClick={() => props.onToggle?.()}
        >
          <Icon name="panelLeftClose" />
        </button>
      </openclaw-tooltip>
    );
  },
  { properties: { onToggle: { default: undefined, attribute: false } } },
);
