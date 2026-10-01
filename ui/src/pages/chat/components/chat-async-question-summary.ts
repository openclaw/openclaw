import { html, nothing } from "lit";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";
import type { AsyncQuestionPresentation, AsyncQuestions } from "./chat-async-question.types.ts";
import { questionDraftValues } from "./chat-question-answer-controls.ts";

function draftForAnswer(
  question: AsyncQuestions["questions"][number],
  answer: string,
): QuestionDraft {
  const values = answer ? answer.split(", ") : [];
  const selected =
    values.length > 0 && values.every((value) => question.options?.includes(value))
      ? new Set(values)
      : new Set<string>();
  return { selected, freeText: selected.size > 0 ? "" : answer };
}

export function parseGeneratedAsyncAnswer(
  question: AsyncQuestions,
  message: string,
): Map<string, QuestionDraft> | null {
  let offset = 0;
  const answers = new Map<string, QuestionDraft>();
  for (let index = 0; index < question.questions.length; index += 1) {
    const current = question.questions[index];
    if (!current) {
      return null;
    }
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
    answers.set(String(index), draftForAnswer(current, answer));
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

export function renderAsyncQuestionSummary(
  questions: AsyncQuestions,
  presentation: AsyncQuestionPresentation,
) {
  const confirmed = presentation.resolved.get(questions.itemId);
  const queued = confirmed ? undefined : presentation.delivery.get(questions.itemId);
  const draft = confirmed ?? presentation.drafts.get(questions.itemId);
  const answers = queued
    ? parseGeneratedAsyncAnswer(questions, queued.text)
    : draft?.status === "submitted"
      ? draft.answers
      : undefined;
  const unparsedText = queued && !answers ? queued.text : confirmed?.unparsedText;
  const archived = presentation.archived.has(questions.itemId);
  const reopening = draft?.status === "reopening";
  const dismissed = draft?.status === "skipped" || reopening;
  const deliveryLabel = confirmed
    ? t("chat.asyncQuestions.sent")
    : queued
      ? t(
          queued.sendState === "failed"
            ? "chat.asyncQuestions.failed"
            : queued.sendState === "unconfirmed"
              ? "chat.queue.deliveryUnconfirmed"
              : queued.sendState === "waiting-reconnect"
                ? "chat.queue.states.waitingForReconnect"
                : queued.sendState === "sending"
                  ? "chat.asyncQuestions.sending"
                  : "chat.asyncQuestions.queued",
        )
      : draft?.status === "submitted"
        ? t("chat.asyncQuestions.awaitingConfirmation")
        : undefined;
  const retryable = queued?.sendState === "failed" || queued?.sendState === "unconfirmed";
  return html`<div class="chat-question-summary" role="status" aria-live="polite">
    ${
      unparsedText
        ? html`<div class="chat-question-summary__prompt">${unparsedText}</div>`
        : questions.questions.map(
            (question, index) => html`<div>
              <strong>${question.title}</strong>
              <div>
                ${
                  answers
                    ? questionDraftValues(answers.get(String(index))).join(", ")
                    : t(
                        reopening
                          ? "chat.asyncQuestions.reopening"
                          : dismissed
                            ? "chat.asyncQuestions.dismissed"
                            : archived
                              ? "chat.asyncQuestions.archived"
                              : "chat.asyncQuestions.inComposer",
                      )
                }
              </div>
            </div>`,
          )
    }
    ${
      deliveryLabel
        ? html`<div class="chat-question-summary__delivery">
            <span>${deliveryLabel}</span>
            ${
              retryable && presentation.retry
                ? html`<button
                    type="button"
                    class="btn btn--sm"
                    @click=${() => presentation.retry?.(queued.id)}
                  >
                    ${t("chat.asyncQuestions.retry")}
                  </button>`
                : nothing
            }
            ${queued?.sendError ? html`<div>${queued.sendError}</div>` : nothing}
          </div>`
        : nothing
    }
    ${
      archived || dismissed
        ? html`<div>
              ${t(dismissed ? "chat.asyncQuestions.dismissedReason" : "chat.asyncQuestions.archivedReason")}
            </div>
            ${dismissed && presentation.storageError ? html`<div role="alert">${presentation.storageError}</div>` : nothing}
            <button
              type="button"
              class="btn btn--sm"
              ?disabled=${reopening}
              @click=${() => presentation.reopen(questions.itemId)}
            >
              ${t("chat.questions.answer")}
            </button>`
        : nothing
    }
  </div>`;
}
