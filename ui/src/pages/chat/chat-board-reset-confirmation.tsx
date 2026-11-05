import "../../components/modal-dialog.tsx";
import { registerChatResetConfirmationEnglish } from "../../i18n/locales/en-chat-reset-confirmation.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatResetConfirmationEnglish);

export type ChatBoardResetConfirmationProps = {
  undoReset?: boolean;
  onResolve: (confirmed: boolean) => void;
};

export function ChatBoardResetConfirmation(props: ChatBoardResetConfirmationProps) {
  let cancelButton!: HTMLButtonElement;
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => cancelButton}
      label={t(props.undoReset ? "chat.sessionReset.undoTitle" : "chat.board.resetTitle")}
      description={t(
        props.undoReset ? "chat.sessionReset.undoDescription" : "chat.board.resetDescription",
      )}
      onModal-cancel={() => props.onResolve(false)}
    >
      <div class="exec-approval-card board-reset-confirmation">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">
              {t(props.undoReset ? "chat.sessionReset.undoTitle" : "chat.board.resetTitle")}
            </div>
            <div class="exec-approval-sub">
              {t(
                props.undoReset
                  ? "chat.sessionReset.undoDescription"
                  : "chat.board.resetDescription",
              )}
            </div>
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
            {t(props.undoReset ? "chat.sessionReset.undoConfirm" : "common.reset")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
