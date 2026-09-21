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
    values.length > 0 &&
    values.every((value) => question.options?.includes(value)) &&
    values.join(", ") === answer
      ? new Set(values)
      : new Set<string>();
  return { selected, freeText: selected.size > 0 ? "" : answer };
}

export function parseGeneratedAsyncAnswer(
  question: AsyncQuestions,
  message: string,
): Map<string, QuestionDraft> | null {
  let offset = 0;
  const answers: string[] = [];
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
    if (index === question.questions.length - 1) {
      answers.push(message.slice(offset));
      offset = message.length;
      break;
    }
    const next = question.questions[index + 1];
    if (!next) {
      return null;
    }
    const separator = `\n\n${quoteQuestion(next.title)}\n\n`;
    const answerEnd = message.indexOf(separator, offset);
    // Free text can contain quoted headings. Do not guess a section boundary.
    if (answerEnd < offset || message.includes(separator, answerEnd + separator.length)) {
      return null;
    }
    answers.push(message.slice(offset, answerEnd));
    offset = answerEnd + 2;
  }
  if (
    offset !== message.length ||
    answers.length !== question.questions.length ||
    answers.some((answer) => !answer.trim())
  ) {
    return null;
  }
  return new Map(
    question.questions.map((entry, index) => [
      String(index),
      draftForAnswer(entry, answers[index] ?? ""),
    ]),
  );
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
  const draft =
    presentation.resolved.get(questions.itemId) ?? presentation.drafts.get(questions.itemId);
  const archived = presentation.archived.has(questions.itemId);
  const reopening = draft?.status === "reopening";
  const dismissed = draft?.status === "skipped" || reopening;
  return html`<div class="chat-question-summary" role="status">
    ${questions.questions.map(
      (question, index) => html`<div>
        <strong>${question.title}</strong>
        <div>
          ${
            draft?.status === "submitted"
              ? questionDraftValues(draft.answers.get(String(index))).join(", ")
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
    )}
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
