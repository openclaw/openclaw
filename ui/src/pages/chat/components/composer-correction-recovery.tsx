import { registerChatCorrectionReviewEnglish } from "../../../i18n/locales/en-chat-correction-review.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ComposerCorrectionReviewProps } from "./composer-correction-review.tsx";

registerEnglishCatalog(registerChatCorrectionReviewEnglish);

/** Keep recognized text recoverable even when the optional review chunk fails to load. */
export function ComposerCorrectionRecovery(
  props: Pick<
    ComposerCorrectionReviewProps,
    "original" | "canKeepOriginal" | "onKeepOriginal" | "onCancel"
  >,
) {
  return (
    <section
      class="card stack composer-correction-recovery"
      aria-label={t("chat.corrections.reviewTitle")}
      style={{ "min-height": 0, "max-height": "60dvh", "flex-shrink": 1, overflow: "auto" }}
    >
      <label class="field">
        <span>{t("chat.corrections.original")}</span>
        <textarea rows={4} readonly value={props.original} style={{ "min-width": 0 }} />
      </label>
      <div class="filters">
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
