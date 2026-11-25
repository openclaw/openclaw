// Secret drafts are cleared by the shared question state owner on settlement.
import type { Question } from "../../../packages/gateway-protocol/src/index.js";

export function clearSecretQuestionDrafts(
  questions: readonly Question[],
  drafts: { delete: (questionId: string) => boolean },
): void {
  for (const question of questions) {
    if (question.isSecret) {
      drafts.delete(question.questionId);
    }
  }
}
