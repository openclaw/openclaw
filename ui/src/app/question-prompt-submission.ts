// Submission payloads are needed only after an explicit answer or skip.
import { isRecord, isStringArray } from "@openclaw/normalization-core/record-coerce";
import type {
  Question,
  QuestionAnswers,
  QuestionResolveParams,
  QuestionResolveResult,
} from "../../../packages/gateway-protocol/src/index.js";

function parseQuestionAnswers(value: unknown): QuestionAnswers | null {
  if (!isRecord(value) || !isRecord(value.answers)) {
    return null;
  }
  const answers: QuestionAnswers["answers"] = {};
  for (const [questionId, answerValue] of Object.entries(value.answers)) {
    if (!/^[a-z][a-z0-9_]*$/.test(questionId) || !isStringArray(answerValue)) {
      return null;
    }
    answers[questionId] = [...answerValue];
  }
  return { answers };
}

export function parseQuestionSubmissionResult(value: unknown): QuestionResolveResult | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.status === "cancelled") {
    return { status: "cancelled" };
  }
  const answers = parseQuestionAnswers(value.answers);
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
