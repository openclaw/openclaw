import { html, nothing } from "lit";

import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";

export type ChatRunControlsProps = {
  canAbort: boolean;
  connected: boolean;
  draft: string;
  hasMessages: boolean;
  isBusy: boolean;
  sending: boolean;
  onAbort?: () => void;
  onExport: () => void;
  onNewSession: () => void;
  onSend: () => void;
  onStoreDraft: (draft: string) => void;
};

export function renderChatRunControls(props: ChatRunControlsProps) {
  return html`
    <div class="agent-chat__toolbar-right">
      ${props.canAbort
        ? nothing
        : html`
            <button
              class="btn btn--ghost"
              @click=${props.onNewSession}
              title={t("chat.welcome.newSession")}
              aria-label={t("chat.welcome.newSession")}
            >
              ${icons.plus}
            </button>
          `}
      <button
        class="btn btn--ghost"
        @click=${props.onExport}
        title="Export"
        aria-label={t("chat.welcome.exportChat")}
        ?disabled=${!props.hasMessages}
      >
        ${icons.download}
      </button>

      ${props.canAbort
        ? html`
            <button
              class="chat-send-btn"
              @click=${() => {
                if (props.draft.trim()) {
                  props.onStoreDraft(props.draft);
                }
                props.onSend();
              }}
              ?disabled=${!props.connected || props.sending}
              title={t("chat.welcome.sendMessage")}
              aria-label={t("chat.welcome.sendMessage")}
            >
              ${icons.send}
            </button>
            <button
              class="chat-send-btn chat-send-btn--stop"
              @click=${props.onAbort}
              title={t("chat.welcome.stopGenerating")}
              aria-label={t("chat.welcome.stopGenerating")}
            >
              ${icons.stop}
            </button>
          `
        : html`
            <button
              class="chat-send-btn"
              @click=${() => {
                if (props.draft.trim()) {
                  props.onStoreDraft(props.draft);
                }
                props.onSend();
              }}
              ?disabled=${!props.connected || props.sending}
              title=${props.isBusy ? t("chat.welcome.queueMessage") : t("chat.welcome.sendMessage")}
              aria-label=${props.isBusy ? t("chat.welcome.queueMessage") : t("chat.welcome.sendMessage")}
            >
              ${icons.send}
            </button>
          `}
    </div>
  `;
}

