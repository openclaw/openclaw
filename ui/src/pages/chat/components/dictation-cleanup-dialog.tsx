import { Show } from "solid-js";
import { ModalDialog } from "../../../components/modal-dialog.tsx";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { DialogHeader } from "../../../components/solid/dialog-header.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatDictationEnglish } from "../../../i18n/locales/en-chat-dictation.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import "./dictation-cleanup-dialog.css";

registerEnglishCatalog(registerChatComposerEnglish);
registerEnglishCatalog(registerChatDictationEnglish);

export function DictationCleanupDialog(props: {
  readDictation: () => ComposerDictationOwner | undefined;
  onClose: () => void;
}) {
  const review = () => props.readDictation()?.cleanupReview;
  const reviewMessage = () => {
    const current = review();
    if (!current || current.status === "unavailable") {
      return "chat.dictation.cleanupUnavailable";
    }
    if (current.status === "pending") {
      return "chat.dictation.cleanupPending";
    }
    if (current.publicationUncertain) {
      return "chat.dictation.cleanupUncertain";
    }
    if (!current.canUseRaw) {
      return "chat.dictation.cleanupManualRecovery";
    }
    if (current.reason === "semantic-unavailable") {
      return "chat.dictation.cleanupSemanticUnavailable";
    }
    return current.status === "failed"
      ? "chat.dictation.cleanupFailed"
      : "chat.dictation.cleanupReady";
  };
  return (
    <ModalDialog
      label={t("chat.composer.dictationCleanup")}
      description={t("chat.dictation.cleanupDescription")}
      onModal-cancel={() => props.onClose()}
    >
      <section class="oc-dialog dictation-cleanup">
        <DialogHeader
          title={t("chat.composer.dictationCleanup")}
          description={t("chat.dictation.cleanupDescription")}
        />
        <div class="oc-dialog__body">
          <label class="field">
            <span>{t("chat.dictation.cleanupMode")}</span>
            <select
              value={props.readDictation()?.cleanupPolicy.mode ?? "off"}
              onChange={(event) =>
                props
                  .readDictation()
                  ?.setCleanupPolicy(
                    event.currentTarget.value === "conservative"
                      ? { mode: "conservative", locale: "en" }
                      : { mode: "off", locale: null },
                  )
              }
            >
              <option value="off">{t("chat.dictation.cleanupOff")}</option>
              <option value="conservative">{t("chat.dictation.cleanupConservative")}</option>
            </select>
          </label>
          <p class="muted">{t("chat.dictation.cleanupPolicyHelp")}</p>
          <p class="muted">{t("chat.dictation.cleanupOffHelp")}</p>
          <Show when={review()}>
            {(current) => (
              <>
                <p role="status" aria-live="polite" aria-atomic="true">
                  {t(reviewMessage())}
                </p>
                <Show when={current().status !== "unavailable" && current().status !== "pending"}>
                  <label class="field">
                    <span>{t("chat.dictation.cleanupOriginal")}</span>
                    <textarea readonly rows="4" value={current().rawText} />
                  </label>
                  <CopyButton
                    text={current().rawText}
                    idleLabel={t("chat.dictation.cleanupCopy")}
                  />
                </Show>
                <p class="muted">{t("chat.dictation.cleanupReviewHint")}</p>
              </>
            )}
          </Show>
        </div>
        <openclaw-modal-actions class="oc-dialog__footer">
          <button type="button" class="btn" onClick={() => props.onClose()}>
            {t("common.close")}
          </button>
          <Show when={review()}>
            <button
              type="button"
              class="btn"
              onClick={() => {
                props.readDictation()?.dismissCleanup();
                props.onClose();
              }}
            >
              {t("chat.dictation.cleanupDismiss")}
            </button>
            <Show when={review()?.canRetry}>
              <button
                type="button"
                class="btn"
                onClick={() => props.readDictation()?.retryCleanup()}
              >
                {t("chat.dictation.cleanupRetry")}
              </button>
            </Show>
            <button
              type="button"
              class="btn primary"
              disabled={!review()?.canUseRaw}
              onClick={() => {
                props.readDictation()?.chooseCleanupRaw();
                if (!props.readDictation()?.cleanupReview) {
                  props.onClose();
                }
              }}
            >
              {t("chat.dictation.cleanupUseOriginal")}
            </button>
          </Show>
        </openclaw-modal-actions>
      </section>
    </ModalDialog>
  );
}
