import "../../components/modal-dialog.tsx";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export type ChatBoardResetConfirmationProps = {
  onResolve: (confirmed: boolean) => void;
};

export function ChatBoardResetConfirmation(props: ChatBoardResetConfirmationProps) {
  let cancelButton!: HTMLButtonElement;
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => cancelButton}
      label={t("chat.board.resetTitle")}
      description={t("chat.board.resetDescription")}
      onModal-cancel={() => props.onResolve(false)}
    >
      <div class="exec-approval-card board-reset-confirmation">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">{t("chat.board.resetTitle")}</div>
            <div class="exec-approval-sub">{t("chat.board.resetDescription")}</div>
          </div>
        </div>
        <openclaw-modal-actions class="exec-approval-actions">
          <button
            ref={(element) => {
              cancelButton = element;
            }}
            class="btn"
            type="button"
            autofocus
            onClick={() => props.onResolve(false)}
          >
            {t("common.cancel")}
          </button>
          <button class="btn primary" type="button" onClick={() => props.onResolve(true)}>
            {t("common.confirm")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
