import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

// SessionMenuActions still consumes a Lit template for its shared Open in submenu.
export function renderHeaderTerminalAction(inline: boolean, disabledReason?: string) {
  return html`<wa-dropdown-item
    slot=${inline ? nothing : "submenu"}
    class="session-menu__item"
    value="continue-in-terminal"
    ?disabled=${Boolean(disabledReason)}
    title=${disabledReason ?? nothing}
    ><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.terminal}</span>
    <span class="session-menu__text">${t("chat.sessionHeader.continueInTerminal.action")}</span>
  </wa-dropdown-item>`;
}

export * from "./chat-header-session-menu.tsx";
