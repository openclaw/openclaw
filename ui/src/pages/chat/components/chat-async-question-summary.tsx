import { createMemo, For, Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatQuestionsEnglish } from "../../../i18n/locales/en-chat-questions.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { isChatSendReconnecting } from "../chat-send-presentation.ts";
import { parseGeneratedAsyncAnswer } from "./chat-async-question-content.ts";
import type { AsyncQuestionPresentation, AsyncQuestions } from "./chat-async-question.types.ts";
import { questionDraftValues } from "./chat-question-answer-controls.ts";

registerEnglishCatalog(registerChatQuestionsEnglish);

registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerChatComposerEnglish);

export function AsyncQuestionSummary(props: {
  questions: AsyncQuestions;
  presentation: AsyncQuestionPresentation;
}) {
  const state = createMemo(() => {
    const { questions, presentation } = props;
    const confirmed = presentation.resolved.get(questions.itemId);
    const queued = confirmed ? undefined : presentation.delivery.get(questions.itemId);
    const draft = confirmed ?? presentation.drafts.get(questions.itemId);
    const answers = queued
      ? parseGeneratedAsyncAnswer(questions, queued.text)
      : draft?.status === "submitted"
        ? draft.answers
        : undefined;
    const reopening = draft?.status === "reopening";
    return {
      queued,
      answers,
      reopening,
      unparsedText: queued && !answers ? queued.text : confirmed?.unparsedText,
      archived: presentation.archived.has(questions.itemId),
      dismissed: draft?.status === "skipped" || reopening,
      deliveryLabel: confirmed
        ? t("chat.asyncQuestions.sent")
        : queued
          ? t(
              queued.sendState === "failed"
                ? "chat.asyncQuestions.failed"
                : isChatSendReconnecting(queued.sendState, presentation.connected)
                  ? "chat.queue.states.waitingForReconnect"
                  : queued.sendState === "sending"
                    ? "chat.asyncQuestions.sending"
                    : "chat.asyncQuestions.queued",
            )
          : draft?.status === "submitted"
            ? t("chat.asyncQuestions.awaitingConfirmation")
            : undefined,
    };
  });
  return (
    <div class="chat-question-summary">
      {/* The announcement region holds text only: focusable controls inside a live region
          get re-announced and interrupt the reader, so the action buttons stay outside it. */}
      <div class="chat-question-summary__announcement" role="status" aria-live="polite">
        <Show
          when={state().unparsedText}
          fallback={
            <For each={props.questions.questions}>
              {(question, index) => (
                <div>
                  <strong>{question.title}</strong>
                  <div>
                    {state().answers
                      ? questionDraftValues(state().answers?.get(String(index())), {}).join(", ")
                      : t(
                          state().reopening
                            ? "chat.asyncQuestions.reopening"
                            : state().dismissed
                              ? "chat.asyncQuestions.dismissed"
                              : state().archived
                                ? "chat.asyncQuestions.archived"
                                : "chat.asyncQuestions.inComposer",
                        )}
                  </div>
                </div>
              )}
            </For>
          }
        >
          {(text) => <div class="chat-question-summary__prompt">{text()}</div>}
        </Show>
      </div>
      <Show when={state().deliveryLabel}>
        {(label) => (
          <div class="chat-question-summary__delivery">
            {/* Each delivery text keeps its own live region so the label and the error stay
                announced, while the Retry control between them stays outside every region and
                keeps the inline placement it has always had. */}
            <span role="status" aria-live="polite">
              {label()}
            </span>
            <Show when={state().queued?.sendState === "failed" && props.presentation.retry}>
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => {
                  const queued = state().queued;
                  if (queued) {
                    props.presentation.retry?.(queued.id);
                  }
                }}
              >
                {t("chat.asyncQuestions.retry")}
              </button>
            </Show>
            <Show when={state().queued?.sendError}>
              {(error) => (
                <div role="status" aria-live="polite">
                  {error()}
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={state().archived || state().dismissed}>
        <div>
          {t(
            state().dismissed
              ? "chat.asyncQuestions.dismissedReason"
              : "chat.asyncQuestions.archivedReason",
          )}
        </div>
        <Show when={state().dismissed && props.presentation.storageError}>
          {(error) => <div role="alert">{error()}</div>}
        </Show>
        <button
          type="button"
          class="btn btn--sm"
          disabled={state().reopening}
          onClick={() => {
            void props.presentation.reopen(props.questions.itemId);
          }}
        >
          {t("chat.questions.answer")}
        </button>
      </Show>
    </div>
  );
}
