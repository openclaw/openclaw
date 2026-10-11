import type { Question, QuestionAnswers } from "../../packages/gateway-protocol/src/index.js";
function canonicalizeQuestionAnswer(question: Question, value: string): string {
  if (question.options.some((option) => option.value !== undefined && option.value === value)) {
    return value;
  }
  const preserveBytes = question.isSecret || question.presentation === "form";
  const candidate = preserveBytes ? value : value.trim();
  const matches = question.options.filter(
    (option) => (preserveBytes ? option.label : option.label.trim()) === candidate,
  );
  const matched = matches.length === 1 ? matches[0] : undefined;
  return matched ? (matched.value ?? matched.label) : candidate;
}

/** Canonical ordinary and secret answer validation shared by question custody. */
export function validateQuestionAnswers(
  questions: Question[],
  answers: QuestionAnswers,
  invalidAnswer: (id: string, reason: string) => Error,
): QuestionAnswers {
  const submittedIds = Object.keys(answers.answers);
  const questionsById = new Map(questions.map((question) => [question.questionId, question]));
  const unknownId = submittedIds.find((id) => !questionsById.has(id));
  if (unknownId) {
    throw invalidAnswer(unknownId, "is not part of this request");
  }
  // Canonical rebuilds every key as an own property, so downstream readers of
  // resolved answers can index the record directly without prototype checks.
  const canonical: QuestionAnswers = {
    answers: Object.fromEntries(questions.map(({ questionId }) => [questionId, []])),
  };
  for (const question of questions) {
    // Object.hasOwn: the id grammar admits "constructor"; a plain index read
    // would return the inherited prototype member instead of undefined.
    const values = Object.hasOwn(answers.answers, question.questionId)
      ? answers.answers[question.questionId]
      : undefined;
    if (!values || values.length === 0) {
      if (question.allowEmpty) {
        canonical.answers[question.questionId] = [];
        continue;
      }
      throw invalidAnswer(question.questionId, "requires an answer");
    }
    if (
      values.some((value) =>
        question.isSecret || question.presentation === "form" ? value.length === 0 : !value.trim(),
      )
    ) {
      throw invalidAnswer(question.questionId, "contains an empty answer");
    }
    if (!question.multiSelect && values.length > 1) {
      throw invalidAnswer(question.questionId, "does not allow multiple answers");
    }
    // Store the option's canonical value (value ?? label) so installed clients
    // sending labels and clients sending values converge on the same answer.
    const canonicalValues = values.map((value) => canonicalizeQuestionAnswer(question, value));
    if (
      question.options.length > 0 &&
      !question.isOther &&
      canonicalValues.some(
        (value) => !question.options.some((option) => (option.value ?? option.label) === value),
      )
    ) {
      throw invalidAnswer(question.questionId, "contains an unknown option");
    }
    canonical.answers[question.questionId] = canonicalValues;
  }
  return canonical;
}
