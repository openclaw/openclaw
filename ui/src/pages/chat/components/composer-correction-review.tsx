import { createUniqueId } from "solid-js";
import { registerChatCorrectionReviewEnglish } from "../../../i18n/locales/en-chat-correction-review.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatCorrectionReviewEnglish);

const transcriptStyle = {
  "max-height": "min(30dvh, 14rem)",
  overflow: "auto",
  "white-space": "pre-wrap",
} as const;
const actionStyle = { "max-width": "100%", "white-space": "normal" } as const;

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
    <section
      class="card stack composer-correction-review"
      aria-labelledby={titleId}
      style={{
        "min-height": 0,
        "max-height": "min(60dvh, 42rem)",
        "flex-shrink": 1,
        overflow: "auto",
        "overscroll-behavior": "contain",
        "overflow-wrap": "anywhere",
      }}
    >
      <h3 class="card-title" id={titleId}>
        {t("chat.corrections.reviewTitle")}
      </h3>
      {/* Announce the review state, not the whole dictated text. */}
      <p class="card-sub" role="status" aria-live="polite" aria-atomic="true">
        {t("chat.corrections.originalReady")}
      </p>
      <p class="card-sub">{t(`chat.corrections.reasons.${props.reason}`)}</p>
      <div
        class="grid"
        style={{ "grid-template-columns": "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))" }}
      >
        <div class="field">
          <span>{t("chat.corrections.original")}</span>
          <div
            class="input"
            role="region"
            aria-label={t("chat.corrections.original")}
            tabindex={0}
            dir="auto"
            style={transcriptStyle}
          >
            {props.original}
          </div>
        </div>
        <div class="field">
          <span>{t("chat.corrections.candidate")}</span>
          <div
            class="input"
            role="region"
            aria-label={t("chat.corrections.candidate")}
            tabindex={0}
            dir="auto"
            style={transcriptStyle}
          >
            {t("chat.corrections.noCandidate")}
          </div>
        </div>
      </div>
      <p class="card-sub">{t("chat.corrections.boundary")}</p>
      <div class="filters" style={{ "justify-content": "flex-end" }}>
        <button type="button" class="btn" style={actionStyle} onClick={() => props.onCancel()}>
          {t("chat.corrections.cancel")}
        </button>
        <button
          type="button"
          class="btn"
          style={actionStyle}
          disabled={!props.canKeepOriginal}
          onClick={() => props.onKeepOriginal()}
        >
          {t("chat.corrections.keepOriginal")}
        </button>
        <button type="button" class="btn primary" style={actionStyle} disabled>
          {t("chat.corrections.accept")}
        </button>
      </div>
    </section>
  );
}
