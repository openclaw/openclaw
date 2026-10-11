import type { JSX } from "@solidjs/web";
import { pathForRoute } from "../../app-route-paths.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../../lib/keyboard-shortcut-contract.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { newSessionSearch, type NewSessionTarget } from "../../pages/new-session/location.ts";
import { renderShortcutHint } from "../kbd.ts";
import { Icon } from "./icon.tsx";
import "../tooltip.ts";

export function renderNewSessionLink(params: {
  basePath: string;
  agentId: string;
  target?: NewSessionTarget;
  className: string;
  label: string;
  disabledReason?: string;
  showShortcut?: boolean;
  onOpen?: (agentId: string, target?: NewSessionTarget) => void;
}): JSX.Element {
  const disabled = Boolean(params.disabledReason);
  const href = `${pathForRoute("new-session", params.basePath)}${newSessionSearch(params.agentId, params.target)}`;
  const hint = params.showShortcut
    ? `${params.label} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.newSession)})`
    : params.label;
  return (
    <openclaw-tooltip
      prop:content={params.disabledReason ?? hint}
      prop:contentTemplate={
        params.disabledReason == null && params.showShortcut
          ? renderShortcutHint(params.label, KEYBOARD_SHORTCUT_COMBOS.newSession)
          : undefined
      }
    >
      <a
        class={params.className}
        role="link"
        href={disabled ? undefined : href}
        aria-label={params.label}
        aria-disabled={disabled ? "true" : undefined}
        tabindex={disabled ? -1 : undefined}
        onContextMenu={(event: MouseEvent) => {
          // Section menus must not replace the browser's Open Link in New Tab actions.
          event.stopPropagation();
        }}
        onClick={(event: MouseEvent) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          if (params.onOpen && shouldHandleNavigationClick(event)) {
            event.preventDefault();
            params.onOpen?.(params.agentId, params.target);
          }
        }}
      >
        <Icon name="plus" />
      </a>
    </openclaw-tooltip>
  );
}
