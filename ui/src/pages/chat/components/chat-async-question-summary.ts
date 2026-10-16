import { solidContent } from "../../../lit/solid-content.tsx";
import { AsyncQuestionSummary } from "./chat-async-question-summary.tsx";
import type { AsyncQuestionPresentation, AsyncQuestions } from "./chat-async-question.types.ts";
export { parseGeneratedAsyncAnswer, quoteQuestion } from "./chat-async-question-summary.tsx";

export function renderAsyncQuestionSummary(
  questions: AsyncQuestions,
  presentation: AsyncQuestionPresentation,
) {
  return solidContent(AsyncQuestionSummary, { questions, presentation });
}
