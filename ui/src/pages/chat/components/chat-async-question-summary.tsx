import { createMemo, For, Show } from "solid-js";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatQuestionsEnglish } from "../../../i18n/locales/en-chat-questions.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { isChatSendReconnecting } from "../chat-send-presentation.ts";
import type { AsyncQuestionPresentation, AsyncQuestions } from "./chat-async-question.types.ts";
import { questionDraftValues } from "./chat-question-answer-controls.ts";

registerEnglishCatalog(registerChatQuestionsEnglish);

registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerChatComposerEnglish);

export function parseGeneratedAsyncAnswer(
  question: AsyncQuestions,
  message: string,
): Map<string, QuestionDraft> | null {
  if (!message.startsWith("> ")) {
    return null;
  }
  let offset = 0;
  const answers = new Map<string, QuestionDraft>();
  for (const [index, current] of question.questions.entries()) {
    const prefix = `${quoteQuestion(current.title)}\n\n`;
    if (!message.startsWith(prefix, offset)) {
      return null;
    }
    offset += prefix.length;
    const next = question.questions[index + 1];
    const separator = next ? `\n\n${quoteQuestion(next.title)}\n\n` : undefined;
    const answerEnd = separator ? message.indexOf(separator, offset) : message.length;
    // Free text can contain quoted headings. Do not guess a section boundary.
    if (
      answerEnd < offset ||
      (separator && message.includes(separator, answerEnd + separator.length))
    ) {
      return null;
    }
    const answer = message.slice(offset, answerEnd);
    if (!answer.trim()) {
      return null;
    }
    const values = answer.split(", ");
    const selected = values.every((value) => current.options?.includes(value))
      ? new Set(values)
      : new Set<string>();
    answers.set(String(index), { selected, freeText: selected.size > 0 ? "" : answer });
    offset = answerEnd + (separator ? 2 : 0);
  }
  return offset === message.length ? answers : null;
}

export function quoteQuestion(title: string): string {
  const encoder = new TextEncoder();
  let quote = "";
  let bytes = 0;
  for (const character of title) {
    bytes += encoder.encode(character).length;
    if (bytes > 512) {
      break;
    }
    quote += character;
  }
  return `> ${quote.replace(/[\r\n]/g, " ")}`;
}

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
                : queued.sendState === "unconfirmed"
                  ? "chat.queue.deliveryUnconfirmed"
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
    <div class="chat-question-summary" role="status" aria-live="polite">
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
      <Show when={state().deliveryLabel}>
        {(label) => (
          <div class="chat-question-summary__delivery">
            <span>{label()}</span>
            <Show
              when={
                (state().queued?.sendState === "failed" ||
                  state().queued?.sendState === "unconfirmed") &&
                props.presentation.retry
              }
            >
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
            <Show when={state().queued?.sendError}>{(error) => <div>{error()}</div>}</Show>
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
