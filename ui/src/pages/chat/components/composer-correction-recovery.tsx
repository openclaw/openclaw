import { lazy } from "solid-js";
import { registerChatCorrectionReviewEnglish } from "../../../i18n/locales/en-chat-correction-review.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
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

// The recovery surface is already loaded with capture; only the full view needs another fetch.
const ComposerCorrectionReview = lazy(() => import("./composer-correction-review.tsx"), {
  export: "ComposerCorrectionReview",
});

export function ComposerCorrectionPresentation(props: {
  review: { original: string; canKeepOriginal: boolean; invalidated: boolean };
  resolve: (choice: "original" | "cancel") => void;
}) {
  const onKeepOriginal = () => props.resolve("original");
  const onCancel = () => props.resolve("cancel");
  return (
    <ChatLazyBoundary
      recovery={
        <ComposerCorrectionRecovery
          original={props.review.original}
          canKeepOriginal={props.review.canKeepOriginal}
          onKeepOriginal={onKeepOriginal}
          onCancel={onCancel}
        />
      }
    >
      <ComposerCorrectionReview
        original={props.review.original}
        reason={props.review.invalidated ? "source-changed" : "corrections-unavailable"}
        canKeepOriginal={props.review.canKeepOriginal}
        onKeepOriginal={onKeepOriginal}
        onCancel={onCancel}
      />
    </ChatLazyBoundary>
  );
}
