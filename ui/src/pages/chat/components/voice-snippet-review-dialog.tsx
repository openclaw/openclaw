import { For, onSettled, Show } from "solid-js";
import { DialogHeader } from "../../../components/solid/dialog-header.tsx";
import { InlineAlert } from "../../../components/solid/inline-alert.tsx";
import { registerChatDictationEnglish } from "../../../i18n/locales/en-chat-dictation.ts";
import { downloadTextFile } from "../../../lib/download.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import type { VoiceSnippetReview } from "../voice-snippet-review.ts";
import "./voice-snippets.css";

registerEnglishCatalog(registerChatDictationEnglish);

type ReviewDialogContext = {
  owner: VoiceSnippetReview;
  signal: AbortSignal;
  returnFocus: HTMLElement | null;
  finish: (accepted: boolean) => void;
};

export function VoiceSnippetReviewDialog(props: { context: ReviewDialogContext }) {
  return (
    <Show when={props.context} keyed>
      {renderVoiceSnippetReviewDialog}
    </Show>
  );
}

function renderVoiceSnippetReviewDialog(options: ReviewDialogContext) {
  const view = projectOwner(options.owner, (owner) => owner.snapshot());
  let source!: HTMLTextAreaElement;
  let preview!: HTMLTextAreaElement;
  const cancel = () => {
    options.owner.cancel();
    options.finish(false);
  };
  const canDownload = () => {
    const snapshot = view.read();
    return (
      !options.signal.aborted &&
      !snapshot.busy &&
      snapshot.problems.length === 0 &&
      (snapshot.canAccept || snapshot.fallbackOnly) &&
      (snapshot.error === null ||
        ["changed-target", "unsupported-encoding"].includes(snapshot.error))
    );
  };
  return (
    <openclaw-modal-dialog
      class="voice-snippets-dialog"
      ref={(modal) => modal.setReturnFocusTarget(options.returnFocus)}
      label={t("chat.dictation.snippets.reviewTitle")}
      prop:initialFocus={() => preview}
      onModal-cancel={cancel}
    >
      <div class="oc-dialog">
        <DialogHeader
          title={t("chat.dictation.snippets.reviewTitle")}
          description={<p>{t("chat.dictation.snippets.reviewDescription")}</p>}
          onClose={cancel}
        />
        <div class="oc-dialog__body">
          <p role="status" aria-live="polite" aria-atomic="true">
            {t("chat.dictation.snippets.reviewReady")}
          </p>
          <Show when={view.read().error}>
            {(error) => (
              <InlineAlert tone="danger" role="alert">
                {t(`chat.dictation.snippets.error.${error()}`)}
              </InlineAlert>
            )}
          </Show>
          <Show when={view.read().fallbackOnly}>
            <InlineAlert tone="warning">{t("chat.dictation.snippets.fallback")}</InlineAlert>
          </Show>
          <label class="voice-snippets-field">
            {t("chat.dictation.snippets.sourceText")}
            <textarea
              class="settings-input voice-snippets-preview"
              readonly
              spellcheck={false}
              value={view.read().sourceText}
              ref={(element) => (source = element)}
            />
          </label>
          <button
            type="button"
            class="btn"
            disabled={view.read().busy || view.read().fallbackOnly}
            onClick={() => options.owner.selectCommand(source.selectionStart, source.selectionEnd)}
          >
            {t("chat.dictation.snippets.selectedPhrase")}
          </button>
          <For each={view.read().problems} keyed={(problem) => problem.intentId}>
            {(problem) => (
              <fieldset class="voice-snippets-choices" disabled={view.read().busy}>
                <legend>{t("chat.dictation.snippets.choose")}</legend>
                <p>{t(`chat.dictation.snippets.error.${problem().code}`)}</p>
                <For each={problem().choices} keyed={(choice) => choice.id}>
                  {(choice) => (
                    <label class="voice-snippets-check">
                      <input
                        type="radio"
                        name={problem().intentId}
                        value={choice().id}
                        onChange={(event) => {
                          if (event.currentTarget.checked) {
                            options.owner.choose(problem().intentId, choice().id);
                            onSettled(() => preview.focus());
                          }
                        }}
                      />
                      {choice().name}
                    </label>
                  )}
                </For>
              </fieldset>
            )}
          </For>
          <label class="voice-snippets-field">
            {t("chat.dictation.snippets.reviewText")}
            <textarea
              class="settings-input voice-snippets-preview"
              readonly
              spellcheck={false}
              value={view.read().text}
              ref={(element) => (preview = element)}
            />
          </label>
          <Show when={view.read().fallbackOnly}>
            <p class="muted">{t("chat.dictation.snippets.encodingHint")}</p>
          </Show>
        </div>
        <openclaw-modal-actions class="oc-dialog__footer">
          <button type="button" class="btn" onClick={cancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class="btn"
            disabled={!canDownload()}
            onClick={() => {
              if (canDownload()) {
                void options.owner.exportText().then((text) => {
                  if (text !== null && !options.signal.aborted) {
                    downloadTextFile("openclaw-dictation.txt", text);
                  }
                });
              }
            }}
          >
            {t("chat.dictation.snippets.download")}
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={!view.read().canAccept || view.read().busy || view.read().fallbackOnly}
            onClick={() => {
              void options.owner.accept().then((result) => {
                if (result) {
                  options.finish(true);
                }
              });
            }}
          >
            {t(
              view.read().busy
                ? "chat.dictation.snippets.working"
                : "chat.dictation.snippets.insert",
            )}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
