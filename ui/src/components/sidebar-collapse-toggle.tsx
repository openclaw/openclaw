import { KEYBOARD_SHORTCUT_COMBOS } from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";
import { ShortcutHint } from "./solid/kbd.tsx";
import "./tooltip.ts";

export function SidebarCollapseToggle(props: { onToggle?: () => void }) {
  return (
    <openclaw-sidebar-collapse-toggle style={{ display: "contents" }}>
      <openclaw-tooltip>
        <span slot="content">
          <ShortcutHint label={t("nav.collapse")} combo={KEYBOARD_SHORTCUT_COMBOS.toggleSidebar} />
        </span>
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
