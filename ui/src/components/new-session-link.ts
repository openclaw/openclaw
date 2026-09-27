import { html, nothing } from "lit";
import { pathForRoute } from "../app-route-paths.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { newSessionSearch, type NewSessionTarget } from "../pages/new-session/location.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

export function renderNewSessionLink(params: {
  basePath: string;
  agentId: string;
  target?: NewSessionTarget;
  className: string;
  label: string;
  disabledReason?: string;
  showShortcut?: boolean;
  onOpen?: (agentId: string, target?: NewSessionTarget) => void;
}) {
  const disabled = Boolean(params.disabledReason);
  const href = `${pathForRoute("new-session", params.basePath)}${newSessionSearch(params.agentId, params.target)}`;
  const hint = params.showShortcut
    ? `${params.label} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.newSession)})`
    : params.label;
  return html`<openclaw-tooltip .content=${params.disabledReason ?? hint}>
    <a
      class=${params.className}
      role="link"
      href=${disabled ? nothing : href}
      aria-label=${params.label}
      aria-disabled=${disabled ? "true" : nothing}
      tabindex=${disabled ? "-1" : nothing}
      @contextmenu=${(event: MouseEvent) => {
        // Section menus must not replace the browser's Open Link in New Tab actions.
        event.stopPropagation();
      }}
      @click=${(event: MouseEvent) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (shouldHandleNavigationClick(event)) {
          event.preventDefault();
          params.onOpen?.(params.agentId, params.target);
        }
      }}
    >
      ${icons.plus}
    </a>
  </openclaw-tooltip>`;
}
