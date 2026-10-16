import { HOME_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { Icon } from "../components/solid/icon.tsx";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";

export function CollapsedHomeToggle() {
  return (
    <openclaw-tooltip
      prop:content={`${t("assistantPanel.toggle")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.homePanel)})`}
    >
      <button
        type="button"
        class="shell-chrome-controls__button shell-chrome-controls__home"
        aria-label={t("assistantPanel.toggle")}
        onClick={() => window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT))}
      >
        <Icon name="home" />
      </button>
    </openclaw-tooltip>
  );
}
