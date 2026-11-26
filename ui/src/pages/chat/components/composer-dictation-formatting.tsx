import { createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import { SanitizedHtml } from "../../../components/solid/sanitized-html.tsx";
import { registerChatDictationFormattingEnglish } from "../../../i18n/locales/en-chat-dictation-formatting.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import type {
  DictationFormattingResult,
  DictationRange,
} from "../../../lib/dictation/formatting.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";

registerEnglishCatalog(registerChatDictationFormattingEnglish);

type FormattingOwner = Pick<
  ComposerDictationOwner,
  | "formattingMode"
  | "setFormattingMode"
  | "acceptFormatting"
  | "dismissFormatting"
  | "reprocessFormatting"
> & { formattingReview: DictationFormattingView | undefined };

export type DictationFormattingView = Omit<
  NonNullable<ComposerDictationOwner["formattingReview"]>,
  "diagnostics"
>;
type FormattingProps = { readDictation: () => FormattingOwner | undefined };

function FormattingMarkerReview(
  props: FormattingProps & {
    result: DictationFormattingResult;
    onConfirmed: () => void;
  },
) {
  const [selected, setSelected] = createSignal<readonly DictationRange[]>([]);
  const contains = (range: DictationRange) =>
    selected().some((item) => item.start === range.start && item.end === range.end);
  return (
    <fieldset disabled={props.readDictation()?.formattingReview?.receipt !== "not-committed"}>
      <legend>{t("chat.dictationFormatting.commands")}</legend>
      <p>{t("chat.dictationFormatting.commandsHint")}</p>
      <For each={props.result.candidates}>
        {(candidate) => (
          <label class="field checkbox">
            <input
              type="checkbox"
              checked={contains(candidate.source)}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((ranges) =>
                  checked
                    ? [...ranges, candidate.source]
                    : ranges.filter(
                        (item) =>
                          item.start !== candidate.source.start ||
                          item.end !== candidate.source.end,
                      ),
                );
              }}
            />
            <span>
              {props.result.originalText.slice(
                Math.max(0, candidate.source.start - 35),
                candidate.source.start,
              )}
              <strong>
                {props.result.originalText.slice(candidate.source.start, candidate.source.end)}
              </strong>
              {props.result.originalText.slice(candidate.source.end, candidate.source.end + 35)}
            </span>
          </label>
        )}
      </For>
      <button
        type="button"
        class="btn"
        disabled={!selected().length}
        onClick={() => {
          const owner = props.readDictation();
          if (
            owner?.formattingReview?.result === props.result &&
            owner.formattingReview.receipt === "not-committed"
          ) {
            owner.reprocessFormatting(selected());
            if (owner.formattingReview && owner.formattingReview.result !== props.result) {
              props.onConfirmed();
            }
          }
        }}
      >
        {t("chat.dictationFormatting.interpret")}
      </button>
    </fieldset>
  );
}

function DictationFormattingModeSelect(props: FormattingProps) {
  const id = createUniqueId();
  return (
    <div class="field">
      <label for={id}>{t("chat.dictationFormatting.mode")}</label>
      <select
        id={id}
        aria-describedby={`${id}-hint`}
        value={props.readDictation()?.formattingMode ?? "preserve"}
        onChange={(event) => {
          const mode = event.currentTarget.value;
          if (mode === "preserve" || mode === "explicit") {
            props.readDictation()?.setFormattingMode(mode);
          }
        }}
      >
        <option value="preserve">{t("chat.dictationFormatting.preserve")}</option>
        <option value="explicit">{t("chat.dictationFormatting.explicit")}</option>
      </select>
      <span id={`${id}-hint`} class="muted">
        {t("chat.dictationFormatting.modeHint")}
      </span>
    </div>
  );
}

export function DictationFormattingReview(props: FormattingProps) {
  let previewControl: HTMLSelectElement | undefined;
  const [preview, setPreview] = createSignal("semantic");
  const [copyFeedback, setCopyFeedback] = createSignal<{
    result: DictationFormattingResult;
    copied: boolean;
  }>();
  let live = true;
  let copyAttempt = 0;
  onSettled(() => () => {
    live = false;
  });
  const review = () => props.readDictation()?.formattingReview;
  const canApply = () => review()?.canApply === true && review()?.receipt === "not-committed";
  const canApplyOriginal = () =>
    review()?.canApplyOriginal === true && review()?.receipt === "not-committed";
  const status = () => {
    const current = review();
    if (current?.receipt === "outcome-unknown") {
      return t("chat.dictationFormatting.unknown");
    }
    if (current?.receipt === "committed") {
      return t("chat.dictationFormatting.committed");
    }
    if (!current || (!current.canApply && !current.canApplyOriginal)) {
      return t("chat.dictationFormatting.stale");
    }
    if (current.result.reason === "too-many-ambiguous-commands") {
      return t("chat.dictationFormatting.commandsLimit");
    }
    if (current.result.status === "raw-fallback") {
      return t("chat.dictationFormatting.fallback");
    }
    if (current.result.status === "needs-review") {
      return t("chat.dictationFormatting.needsReview");
    }
    if (current.result.status === "preserved") {
      return t("chat.dictationFormatting.preserved");
    }
    return t("chat.dictationFormatting.ready");
  };
  const copyPlain = async () => {
    const owner = props.readDictation();
    const result = owner?.formattingReview?.result;
    if (!result) {
      return;
    }
    const attempt = ++copyAttempt;
    const current = () =>
      live &&
      attempt === copyAttempt &&
      props.readDictation() === owner &&
      owner?.formattingReview?.result === result;
    const copied = await copyToClipboard(result.plainText, current);
    if (current()) {
      setCopyFeedback({ result, copied });
    }
  };
  return (
    <Show when={review()}>
      {(current) => (
        <fieldset
          class="dictation-formatting card stack"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              props.readDictation()?.dismissFormatting();
            }
          }}
        >
          <legend>{t("chat.dictationFormatting.title")}</legend>
          <div role="status" aria-live="polite" aria-atomic="true">
            <p>{status()}</p>
            <Show when={!current().canApply && canApplyOriginal()}>
              <p>{t("chat.dictationFormatting.wholeMessageHint")}</p>
            </Show>
            <Show when={current().result.document}>
              <p>
                {t("chat.dictationFormatting.structure", {
                  paragraphs: String(
                    current().result.document?.blocks.filter((block) => block.type === "paragraph")
                      .length ?? 0,
                  ),
                  items: String(current().result.counts.items),
                })}
              </p>
            </Show>
            <Show when={copyFeedback()?.result === current().result}>
              <p>
                {t(
                  copyFeedback()?.copied
                    ? "chat.dictationFormatting.copied"
                    : "chat.dictationFormatting.copyFailed",
                )}
              </p>
            </Show>
          </div>
          <DictationFormattingModeSelect readDictation={props.readDictation} />
          <p class="muted">{t("chat.dictationFormatting.reprocessHint")}</p>
          <Show when={current().result} keyed>
            {(result) => (
              <Show when={result.candidates.length}>
                <FormattingMarkerReview
                  result={result}
                  readDictation={props.readDictation}
                  onConfirmed={() =>
                    onSettled(() => previewControl?.focus({ preventScroll: true }))
                  }
                />
              </Show>
            )}
          </Show>
          <label class="field">
            <span>{t("chat.dictationFormatting.preview")}</span>
            <select
              ref={(element) => {
                previewControl = element;
              }}
              value={current().result.html ? preview() : "plain"}
              onChange={(event) => setPreview(event.currentTarget.value)}
            >
              <option value="semantic" disabled={!current().result.html}>
                {t("chat.dictationFormatting.semantic")}
              </option>
              <option value="plain">{t("chat.dictationFormatting.plain")}</option>
            </select>
          </label>
          <Show
            when={preview() === "semantic" && current().result.html}
            fallback={
              <textarea
                class="dictation-formatting__preview code-block"
                aria-label={t("chat.dictationFormatting.plain")}
                readonly
                rows={6}
                value={current().result.plainText}
              />
            }
          >
            <SanitizedHtml
              class="dictation-formatting__preview code-block"
              role="region"
              aria-label={t("chat.dictationFormatting.semantic")}
              tabindex={0}
              html={current().result.html}
            />
          </Show>
          <details>
            <summary>{t("chat.dictationFormatting.original")}</summary>
            <textarea
              class="dictation-formatting__preview code-block"
              aria-label={t("chat.dictationFormatting.original")}
              readonly
              rows={4}
              value={current().result.originalText}
            />
          </details>
          <div class="wrap-row">
            <button
              type="button"
              class="btn primary"
              disabled={!canApply() || current().result.status === "raw-fallback"}
              onClick={() => props.readDictation()?.acceptFormatting("formatted")}
            >
              {t("chat.dictationFormatting.formattedAction")}
            </button>
            <button
              type="button"
              class="btn"
              disabled={!canApplyOriginal()}
              onClick={() => props.readDictation()?.acceptFormatting("original")}
            >
              {t("chat.dictationFormatting.originalAction")}
            </button>
            <button type="button" class="btn" onClick={() => void copyPlain()}>
              {t("chat.dictationFormatting.copy")}
            </button>
            <button
              type="button"
              class="btn"
              disabled={current().receipt !== "not-committed"}
              onClick={() => props.readDictation()?.reprocessFormatting()}
            >
              {t("chat.dictationFormatting.reprocess")}
            </button>
            <button
              type="button"
              class="btn"
              onClick={() => props.readDictation()?.dismissFormatting()}
            >
              {t("chat.dictationFormatting.dismiss")}
            </button>
          </div>
        </fieldset>
      )}
    </Show>
  );
}
