// Control UI chat module implements run controls behavior.
import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";

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
  showSecondary?: boolean;
};

export function renderChatRunControls(props: ChatRunControlsProps) {
  const showSecondary = props.showSecondary ?? true;
  return html`
    <div class="agent-chat__toolbar-right">
      ${showSecondary && !props.canAbort
        ? html`
            <openclaw-tooltip .content=${t("chat.runControls.newSession")}>
              <button
                class="btn btn--ghost"
                @click=${props.onNewSession}
                aria-label=${t("chat.runControls.newSession")}
              >
                ${icons.plus}
                <span class="agent-chat__control-label">${t("chat.runControls.newSession")}</span>
              </button>
            </openclaw-tooltip>
          `
        : nothing}
      ${showSecondary
        ? html`
            <openclaw-tooltip .content=${t("chat.runControls.export")}>
              <button
                class="btn btn--ghost"
                @click=${props.onExport}
                aria-label=${t("chat.runControls.exportChat")}
                ?disabled=${!props.hasMessages}
              >
                ${icons.download}
                <span class="agent-chat__control-label">${t("chat.runControls.export")}</span>
              </button>
            </openclaw-tooltip>
          `
        : nothing}
      ${props.canAbort
        ? html`
            <openclaw-tooltip .content=${t("chat.runControls.queue")}>
              <button
                class="chat-send-btn"
                @click=${() => {
                  if (props.draft.trim()) {
                    props.onStoreDraft(props.draft);
                  }
                  props.onSend();
                }}
                ?disabled=${!props.connected || props.sending}
                aria-label=${t("chat.runControls.queueMessage")}
              >
                ${icons.send}
                <span class="agent-chat__control-label">${t("chat.runControls.queue")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${t("chat.runControls.stop")}>
              <button
                class="chat-send-btn chat-send-btn--stop"
                @click=${props.onAbort}
                aria-label=${t("chat.runControls.stopGenerating")}
              >
                ${icons.stop}
                <span class="agent-chat__control-label">${t("chat.runControls.stop")}</span>
              </button>
            </openclaw-tooltip>
          `
        : html`
            <openclaw-tooltip
              .content=${props.isBusy ? t("chat.runControls.queue") : t("chat.runControls.send")}
            >
              <button
                class="chat-send-btn"
                @click=${() => {
                  if (props.draft.trim()) {
                    props.onStoreDraft(props.draft);
                  }
                  props.onSend();
                }}
                ?disabled=${!props.connected || props.sending}
                aria-label=${props.isBusy
                  ? t("chat.runControls.queueMessage")
                  : t("chat.runControls.sendMessage")}
              >
                ${icons.send}
                <span class="agent-chat__control-label"
                  >${props.isBusy ? t("chat.runControls.queue") : t("chat.runControls.send")}</span
                >
              </button>
            </openclaw-tooltip>
          `}
    </div>
  `;
}
