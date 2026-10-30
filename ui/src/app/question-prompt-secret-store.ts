// Store-bound question ownership keeps credential metadata and plaintext handling together.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  Question,
  QuestionAnswers,
  QuestionResolveParams,
  QuestionResolveResult,
} from "../../../packages/gateway-protocol/src/index.js";

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

export function parseQuestionSubmissionResult(
  value: unknown,
  parseAnswers: (value: unknown) => QuestionAnswers | null,
): QuestionResolveResult | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.status === "cancelled") {
    return { status: "cancelled" };
  }
  const answers = parseAnswers(value.answers);
  return value.status === "answered" && answers ? { status: "answered", answers } : null;
}

export function prepareQuestionSecretStoreSubmission(
  id: string,
  questions: readonly Question[],
  resolution: { answers: QuestionAnswers["answers"] } | { cancel: true },
  allowedHostsDraft?: string,
): { requestParams: QuestionResolveParams; submittedAnswers?: QuestionAnswers } {
  if (!("answers" in resolution)) {
    return { requestParams: { id, cancel: true } };
  }
  const requestAnswers: QuestionAnswers = {
    answers: Object.fromEntries(
      Object.entries(resolution.answers).map(([questionId, answers]) => [questionId, [...answers]]),
    ),
  };
  const secretQuestion = questions[0]?.secretStore ? questions[0] : undefined;
  const allowedHosts =
    secretQuestion?.secretStore?.kind === "secret"
      ? allowedHostsDraft !== undefined
        ? allowedHostsDraft.split(/[,\s]+/u).filter(Boolean)
        : secretQuestion.secretStore.allowedHosts
      : undefined;
  return {
    requestParams: {
      id,
      answers: requestAnswers,
      ...(allowedHosts !== undefined ? { secretStoreAllowedHosts: allowedHosts } : {}),
    },
    // The Gateway owns redaction: retained prompt state receives its synthetic
    // marker while plaintext remains only in the outbound request payload.
    submittedAnswers: secretQuestion
      ? { answers: { [secretQuestion.questionId]: ["stored"] } }
      : requestAnswers,
  };
}
