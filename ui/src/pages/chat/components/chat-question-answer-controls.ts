import type { Question } from "@openclaw/gateway-protocol";
import type { QuestionDraft } from "../../../app/question-prompt.ts";

export function questionDraftValues(
  draft: QuestionDraft | undefined,
  question: Pick<Question, "isSecret" | "presentation" | "answerFormat">,
): string[] {
  const freeText = questionPreservesWhitespace(question) ? draft?.freeText : draft?.freeText.trim();
  const answerFormat = question.answerFormat;
  const custom = freeText ? (answerFormat === "lines" ? freeText.split(/\r?\n/u) : [freeText]) : [];
  return [...(draft?.selected ?? []), ...custom];
}

/** Defaults initialize presentation once; revisiting a field never restores a cleared answer. */
export function initializeQuestionDrafts(
  questions: readonly Question[],
  drafts: Map<string, QuestionDraft>,
): void {
  for (const question of questions) {
    if (drafts.has(question.questionId) || !question.defaultAnswers || question.isSecret) {
      continue;
    }
    const labels = new Set(question.options.map((option) => option.value ?? option.label));
    drafts.set(question.questionId, {
      selected: new Set(question.defaultAnswers.filter((value) => labels.has(value))),
      freeText: question.defaultAnswers
        .filter((value) => !labels.has(value))
        .join(question.answerFormat === "lines" ? "\n" : ""),
    });
  }
}

export function questionPreservesWhitespace(
  question: Pick<Question, "isSecret" | "presentation">,
): boolean {
  return question.isSecret === true || question.presentation === "form";
}
