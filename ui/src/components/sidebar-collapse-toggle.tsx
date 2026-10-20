import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";
import "./tooltip.ts";

export function SidebarCollapseToggle(props: { onToggle?: () => void }) {
  return (
    <openclaw-sidebar-collapse-toggle style={{ display: "contents" }}>
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
    </openclaw-sidebar-collapse-toggle>
  );
}
