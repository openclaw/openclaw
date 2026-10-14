import { html } from "lit";
import { icons } from "../components/icons.ts";
import { HOME_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { t } from "../i18n/index.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";

export function renderCollapsedHomeToggle() {
  return html`<openclaw-tooltip
    .content=${`${t("assistantPanel.toggle")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.homePanel)})`}
  >
    <button
      type="button"
      class="shell-chrome-controls__button shell-chrome-controls__home"
      aria-label=${t("assistantPanel.toggle")}
      @click=${() => window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT))}
    >
      ${icons.home}
    </button>
  </openclaw-tooltip>`;
}
