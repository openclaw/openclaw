import { createUniqueId, For, Show } from "solid-js";
import { registerChatCorrectionsEnglish } from "../../../i18n/locales/en-chat-corrections.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { DictationRefinementReason } from "../dictation-refinement.ts";
import "../../../styles/composer-correction-review.css";

registerEnglishCatalog(registerChatCorrectionsEnglish);

export type ComposerCorrectionChange = {
  id: string;
  original: string;
  replacement: string;
};

export type ComposerCorrectionReviewProps = {
  original: string;
  candidate: string | null;
  changes: readonly ComposerCorrectionChange[];
  correctionCount: number;
  reason?: DictationRefinementReason;
  canAccept: boolean;
  canKeepOriginal: boolean;
  onKeepOriginal: () => void;
  onAcceptCorrection: () => void;
  onCancel: () => void;
};

/** Presentation only: the dictation owner admits each choice against the current draft. */
export function ComposerCorrectionReview(props: ComposerCorrectionReviewProps) {
  const titleId = `composer-correction-title-${createUniqueId()}`;
  const status = () =>
    props.correctionCount === 0
      ? t("chat.corrections.originalReady")
      : props.correctionCount === 1
        ? t("chat.corrections.oneReady")
        : t("chat.corrections.manyReady", { count: String(props.correctionCount) });
  return (
    <section class="composer-correction-review" aria-labelledby={titleId}>
      <h3 class="composer-correction-review__title" id={titleId}>
        {t("chat.corrections.reviewTitle")}
      </h3>
      {/* Announce the settled count, never every token or the whole dictated text. */}
      <p
        class="composer-correction-review__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {status()}
      </p>
      <Show when={props.reason}>
        {(reason) => (
          <p class="composer-correction-review__reason">
            {t(`chat.corrections.reasons.${reason()}`)}
          </p>
        )}
      </Show>
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
            {props.candidate === null
              ? t("chat.corrections.noCandidate")
              : props.candidate === ""
                ? t("chat.corrections.emptyCandidate")
                : props.candidate}
          </div>
        </div>
      </div>
      <Show when={props.changes.length > 0}>
        <details class="composer-correction-review__changes">
          <summary>{t("chat.corrections.changes")}</summary>
          <ol class="composer-correction-review__change-list">
            <For each={props.changes} keyed={(change) => change.id}>
              {(change) => (
                <li>
                  <strong>{t("chat.corrections.before")}</strong>
                  <span class="composer-correction-review__change-text" dir="auto">
                    {change().original}
                  </span>
                  <strong>{t("chat.corrections.after")}</strong>
                  <span class="composer-correction-review__change-text" dir="auto">
                    {change().replacement || t("chat.corrections.removed")}
                  </span>
                </li>
              )}
            </For>
          </ol>
        </details>
      </Show>
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
        <button
          type="button"
          class="btn primary"
          disabled={!props.canAccept || props.candidate === null}
          onClick={() => props.onAcceptCorrection()}
        >
          {t("chat.corrections.accept")}
        </button>
      </div>
    </section>
  );
}

export function ComposerCorrectionControls(props: {
  policy: "off" | "explicit";
  literal: boolean;
  disabled?: boolean;
  onPolicyChange: (policy: "off" | "explicit") => void;
  onLiteralChange: (literal: boolean) => void;
}) {
  const hintId = `composer-correction-literal-${createUniqueId()}`;
  return (
    <div class="composer-correction-controls">
      <label class="composer-correction-controls__policy">
        <span>{t("chat.corrections.policy")}</span>
        <select
          value={props.policy}
          disabled={props.disabled}
          onChange={(event) =>
            props.onPolicyChange(event.currentTarget.value === "explicit" ? "explicit" : "off")
          }
        >
          <option value="off">{t("chat.corrections.off")}</option>
          <option value="explicit">{t("chat.corrections.explicit")}</option>
        </select>
      </label>
      <label class="composer-correction-controls__literal">
        <input
          type="checkbox"
          checked={props.literal}
          disabled={props.disabled || props.policy === "off"}
          aria-describedby={hintId}
          onChange={(event) => props.onLiteralChange(event.currentTarget.checked)}
        />
        <span>{t("chat.corrections.literal")}</span>
      </label>
      <span class="sr-only" id={hintId}>
        {t("chat.corrections.literalHint")}
      </span>
    </div>
  );
}
