import { ConnectCommand } from "../../../components/solid/connect-command.tsx";
import "../../../components/modal-dialog.tsx";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

export type ContinueInTerminalDialogProps = { command: string; onClose: () => void };

export function ContinueInTerminalDialog(props: ContinueInTerminalDialogProps) {
  return (
    <openclaw-modal-dialog
      class="continue-in-terminal-dialog"
      label={t("chat.sessionHeader.continueInTerminal.title")}
      description={t("chat.sessionHeader.continueInTerminal.description")}
      onModal-cancel={() => props.onClose()}
    >
      <section class="exec-approval-card continue-in-terminal-dialog__card">
        <header class="continue-in-terminal-dialog__header">
          <h2>{t("chat.sessionHeader.continueInTerminal.title")}</h2>
          <p>{t("chat.sessionHeader.continueInTerminal.description")}</p>
        </header>
        <ConnectCommand command={props.command} />
        <p class="continue-in-terminal-dialog__note">
          {t("chat.sessionHeader.continueInTerminal.authNote")}
        </p>
        <openclaw-modal-actions class="exec-approval-actions">
          <button type="button" class="btn primary" onClick={() => props.onClose()}>
            {t("common.close")}
          </button>
        </openclaw-modal-actions>
      </section>
    </openclaw-modal-dialog>
  );
}
