import { html, nothing } from "lit";
import {
  SESSION_COLOR_IDS,
  normalizeSessionColorValue,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  type KeyboardShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { icons } from "./icons.ts";

export function sessionArchiveShortcut(state: {
  session: { archived: boolean };
  selectionCount: number;
  archiveShortcut?: boolean;
}): KeyboardShortcutCombo | undefined {
  return state.archiveShortcut && state.selectionCount === 1 && !state.session.archived
    ? KEYBOARD_SHORTCUT_COMBOS.archiveSession
    : undefined;
}

export function renderSessionColorOptions(params: {
  color: string | null;
  allowDefault?: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSelect: (event: MouseEvent, color: string | null) => void;
}) {
  const current = normalizeSessionColorValue(params.color ?? "");
  return html`<div
    class="session-menu__colors"
    role="group"
    aria-label=${t("sessionsView.setColorMenu")}
  >
    ${(params.allowDefault === false ? SESSION_COLOR_IDS : [null, ...SESSION_COLOR_IDS]).map(
      (color) => {
        const label = color ? t(`sessionsView.colors.${color}`) : t("sessionsView.noColor");
        const selected = current === color && (color !== null || !params.color);
        return html`<button
          type="button"
          class="session-menu__color-choice"
          aria-label=${label}
          aria-pressed=${String(selected)}
          ?disabled=${params.disabled}
          title=${params.disabledReason ?? label}
          @click=${(event: MouseEvent) => params.onSelect(event, color)}
        >
          <span
            class=${`session-menu__color-swatch${color === null ? " session-menu__color-swatch--none" : ""}`}
            style=${color ? `background: var(--session-color-${color})` : nothing}
            aria-hidden="true"
            >${color === null ? icons.circleX : selected ? icons.check : nothing}</span
          >
        </button>`;
      },
    )}
  </div>`;
}
