import { createUniqueId } from "solid-js";
import { registerChatCorrectionsEnglish } from "../../../i18n/locales/en-chat-corrections.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/composer-correction-review.css";

registerEnglishCatalog(registerChatCorrectionsEnglish);

export type ComposerCorrectionReviewProps = {
  original: string;
  reason: "source-changed" | "corrections-unavailable";
  canKeepOriginal: boolean;
  onKeepOriginal: () => void;
  onCancel: () => void;
};

/** Presentation only: the dictation owner admits each choice against the current draft. */
export function ComposerCorrectionReview(props: ComposerCorrectionReviewProps) {
  const titleId = `composer-correction-title-${createUniqueId()}`;
  return (
    <section class="composer-correction-review" aria-labelledby={titleId}>
      <h3 class="composer-correction-review__title" id={titleId}>
        {t("chat.corrections.reviewTitle")}
      </h3>
      {/* Announce the review state, not the whole dictated text. */}
      <p
        class="composer-correction-review__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {t("chat.corrections.originalReady")}
      </p>
      <p class="composer-correction-review__reason">
        {t(`chat.corrections.reasons.${props.reason}`)}
      </p>
      <div class="composer-correction-review__versions">
        <div class="composer-correction-review__version">
          <span class="composer-correction-review__label">{t("chat.corrections.original")}</span>
          <div
            class="composer-correction-review__text"
            role="region"
            aria-label={t("chat.corrections.original")}
            tabindex={0}
            dir="auto"
          >
            {props.original}
          </div>
        </div>
        <div class="composer-correction-review__version">
          <span class="composer-correction-review__label">{t("chat.corrections.candidate")}</span>
          <div
            class="composer-correction-review__text"
            role="region"
            aria-label={t("chat.corrections.candidate")}
            tabindex={0}
            dir="auto"
          >
            {t("chat.corrections.noCandidate")}
          </div>
        </div>
      </div>
      <p class="composer-correction-review__boundary">{t("chat.corrections.boundary")}</p>
      <div class="composer-correction-review__actions">
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
        <button type="button" class="btn primary" disabled>
          {t("chat.corrections.accept")}
        </button>
      </div>
    </section>
  );
}
