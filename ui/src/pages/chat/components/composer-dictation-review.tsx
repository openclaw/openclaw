import { createMemo, createSignal, Show } from "solid-js";
import type { DictationPunctuationPolicy } from "../../../lib/dictation-refinement.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import { DictationPunctuationFields } from "./dictation-punctuation-fields.tsx";

export function ComposerDictationReview(props: {
  readDictation: () => ComposerDictationOwner | undefined;
}) {
  const review = createMemo(() => props.readDictation()?.review);
  const sourcePolicy = createMemo(() => review()?.policy);
  // This is the user's unsent policy draft. A new owner policy resets it after reprocessing.
  const [policy, setPolicy] = createSignal<DictationPunctuationPolicy>(
    () => sourcePolicy() ?? { mode: "verbatim", explicitEnabled: false },
  );
  const attempted = () => review()?.delivery !== "not-attempted";
  return (
    <Show when={review()}>
      {(current) => (
        <section class="dictation-review" aria-label={t("chat.dictation.punctuation.reviewTitle")}>
          <h3>{t("chat.dictation.punctuation.reviewTitle")}</h3>
          <p role="status" aria-live="polite" aria-atomic="true">
            {t(`chat.dictation.punctuation.status.${current().result.status}`)}{" "}
            {current().limitation
              ? t(`chat.dictation.punctuation.limitations.${current().limitation}`)
              : current().result.reasons[0]
                ? t(`chat.dictation.punctuation.reasons.${current().result.reasons[0]}`)
                : ""}{" "}
            {attempted() ? t(`chat.dictation.punctuation.delivery.${current().delivery}`) : ""}
            {current().undoOutcome !== "not-attempted"
              ? ` ${t(`chat.dictation.punctuation.undoOutcome.${current().undoOutcome}`)}`
              : ""}
          </p>
          <label>
            <span>{t("chat.dictation.punctuation.original")}</span>
            <textarea rows={3} readonly value={current().rawText} />
          </label>
          <label>
            <span>
              {t(
                current().selected === "original"
                  ? "chat.dictation.punctuation.selectedOriginal"
                  : "chat.dictation.punctuation.proposed",
              )}
            </span>
            <textarea rows={3} readonly value={current().result.text} />
          </label>
          <details>
            <summary>{t("chat.dictation.punctuation.changePolicy")}</summary>
            <DictationPunctuationFields
              value={policy()}
              disabled={attempted()}
              onChange={(next) => next && setPolicy(next)}
            />
            <p>{t("chat.dictation.punctuation.reprocessHelp")}</p>
            <button
              type="button"
              class="btn"
              disabled={attempted() || !current().canInsert}
              onClick={() => props.readDictation()?.reprocess(policy())}
            >
              {t("chat.dictation.punctuation.reprocess")}
            </button>
          </details>
          <div class="dictation-review__actions">
            <button
              type="button"
              class="btn"
              onClick={() => props.readDictation()?.dismissReview()}
            >
              {t("chat.dictation.punctuation.dismiss")}
            </button>
            <Show when={current().canUndo}>
              <button
                type="button"
                class="btn"
                onClick={() => props.readDictation()?.undoReviewed()}
              >
                {t("chat.dictation.punctuation.undo")}
              </button>
            </Show>
            <button
              type="button"
              class="btn"
              disabled={attempted() || !current().canInsert || current().selected === "original"}
              onClick={() => props.readDictation()?.chooseOriginal()}
            >
              {t("chat.dictation.punctuation.useOriginal")}
            </button>
            <button
              type="button"
              class="btn primary"
              disabled={attempted() || !current().canInsert}
              onClick={() => props.readDictation()?.insertReviewed()}
            >
              {t("chat.dictation.punctuation.insert")}
            </button>
          </div>
        </section>
      )}
    </Show>
  );
}
