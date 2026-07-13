import { html } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";

type NewSessionComposerOptions = {
  canSubmit: boolean;
  message: string;
  submitting: boolean;
  onInput: (message: string) => void;
  onKeydown: (event: KeyboardEvent) => void;
  onSubmit: () => void;
};

/** Draft message box styled as the chat composer shell so both pickers match. */
export function renderNewSessionComposer(options: NewSessionComposerOptions) {
  const startLabel = options.submitting ? t("newSession.starting") : t("newSession.start");
  return html`
    <div class="agent-chat__input new-session-page__composer">
      <div class="agent-chat__composer-input-row">
        <div class="agent-chat__composer-combobox">
          <textarea
            class="new-session-page__message"
            rows="3"
            ?disabled=${options.submitting}
            placeholder=${t("newSession.messagePlaceholder")}
            .value=${options.message}
            @input=${(event: Event) => options.onInput((event.target as HTMLTextAreaElement).value)}
            @keydown=${options.onKeydown}
          ></textarea>
        </div>
        <div class="agent-chat__composer-actions">
          <openclaw-tooltip content=${t("newSession.start")}>
            <button
              type="button"
              class="chat-send-btn"
              ?disabled=${!options.canSubmit}
              aria-label=${startLabel}
              @click=${options.onSubmit}
            >
              ${options.submitting ? icons.loader : icons.arrowUp}
            </button>
          </openclaw-tooltip>
        </div>
      </div>
    </div>
  `;
}
