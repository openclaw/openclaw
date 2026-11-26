import { registerChatCorrectionsEnglish } from "../../../i18n/locales/en-chat-corrections.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ComposerCorrectionReviewProps } from "./composer-correction-review.tsx";
import "../../../styles/composer-correction-recovery.css";

registerEnglishCatalog(registerChatCorrectionsEnglish);

/** Keep recognized text recoverable even when the optional review chunk fails to load. */
export function ComposerCorrectionRecovery(
  props: Pick<
    ComposerCorrectionReviewProps,
    "original" | "canKeepOriginal" | "onKeepOriginal" | "onCancel"
  >,
) {
  return (
    <section
      class="card composer-correction-recovery"
      aria-label={t("chat.corrections.reviewTitle")}
    >
      <label class="field">
        <span>{t("chat.corrections.original")}</span>
        <textarea rows={4} readonly value={props.original} />
      </label>
      <div class="composer-correction-recovery__actions">
        <button type="button" class="btn" onClick={() => props.onCancel()}>
          {t("chat.corrections.cancel")}
        </button>
        <button
          type="button"
          class="btn"
          disabled={!props.canKeepOriginal}
          onClick={() => props.onKeepOriginal()}
        >
          {t("chat.corrections.keepOriginal")}
        </button>
      </div>
    </section>
  );
}
