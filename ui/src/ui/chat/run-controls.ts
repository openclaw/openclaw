import { html, nothing } from "lit";
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
  const sendButton = props.canAbort
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
          title="Queue"
          aria-label="Queue message"
        >
          ${icons.send}
        </button>
        <button
          class="chat-send-btn chat-send-btn--stop"
          @click=${props.onAbort}
          title="Stop"
          aria-label="Stop generating"
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
          title=${props.isBusy ? "Queue" : "Send"}
          aria-label=${props.isBusy ? "Queue message" : "Send message"}
        >
          ${icons.send}
        </button>
      `;

  return html`
    <div class="agent-chat__toolbar-right">
      ${props.canAbort
        ? nothing
        : html`
            <button
              class="btn btn--ghost agent-chat__desktop-run-control"
              @click=${props.onNewSession}
              title="New session"
              aria-label="New session"
            >
              ${icons.plus}
            </button>
          `}
      <button
        class="btn btn--ghost agent-chat__desktop-run-control"
        @click=${props.onExport}
        title="Export"
        aria-label="Export chat"
        ?disabled=${!props.hasMessages}
      >
        ${icons.download}
      </button>

      <details class="agent-chat__mobile-actions">
        <summary
          class="agent-chat__input-btn agent-chat__mobile-actions-toggle"
          title="More chat actions"
          aria-label="More chat actions"
        >
          ${icons.moreHorizontal}
        </summary>
        <div class="agent-chat__mobile-actions-sheet" role="menu">
          ${props.canAbort
            ? nothing
            : html`
                <button type="button" role="menuitem" @click=${props.onNewSession}>
                  ${icons.plus}<span>New session</span>
                </button>
              `}
          <button
            type="button"
            role="menuitem"
            @click=${props.onExport}
            ?disabled=${!props.hasMessages}
          >
            ${icons.download}<span>Export chat</span>
          </button>
        </div>
      </details>

      ${sendButton}
    </div>
  `;
}
