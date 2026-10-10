import { html, nothing } from "lit";
import { ref, type Ref } from "lit/directives/ref.js";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import type { TerminalSessionInfo } from "./terminal-connection.ts";

type TerminalSessionPickerProps = {
  open: boolean;
  hosted: boolean;
  triggerRef: Ref<HTMLButtonElement>;
  loading: boolean;
  sessions: TerminalSessionInfo[];
  currentSessionIds: ReadonlySet<string>;
  onToggle: () => void;
  onDismiss: (restoreFocus: boolean) => void;
  onFocusOut: (event: FocusEvent) => void;
  onRefresh: () => void;
  onAttach: (sessionId: string, owner: TerminalSessionInfo["owner"]) => void;
};

const TERMINAL_SESSION_PICKER_ID = "terminal-session-picker-dialog";

export function renderTerminalSessionPickerTrigger(props: TerminalSessionPickerProps) {
  return html`<button
    ${ref(props.triggerRef)}
    class=${props.hosted ? "rail-header__action" : "rail-header__action tp-icon"}
    type="button"
    title=${props.hosted ? nothing : t("terminal.sessions")}
    aria-label=${t("terminal.sessions")}
    aria-expanded=${props.open ? "true" : "false"}
    aria-haspopup="dialog"
    aria-controls=${props.hosted ? nothing : TERMINAL_SESSION_PICKER_ID}
    @click=${props.onToggle}
    @focusout=${props.onFocusOut}
  >
    ${icons.server}
  </button>`;
}
