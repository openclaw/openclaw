import type { QuestionRecord } from "@openclaw/gateway-protocol";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { parseQuestion } from "./question-prompt-parse.ts";

function readTimestamp(value: unknown): number | null {
  return asSafeIntegerInRange(value, { min: 0 }) ?? null;
}

function parseQuestionAnswers(value: unknown): { answers: Record<string, string[]> } | null {
  if (!isRecord(value) || !isRecord(value.answers)) {
    return null;
  }
  const answers: Record<string, string[]> = {};
  for (const [questionId, answerValue] of Object.entries(value.answers)) {
    if (
      !/^[a-z][a-z0-9_]*$/.test(questionId) ||
      !Array.isArray(answerValue) ||
      !answerValue.every((answer) => typeof answer === "string")
    ) {
      return null;
    }
    answers[questionId] = [...answerValue];
  }
  return { answers };
}

export function parseQuestionRecord(payload: unknown): QuestionRecord | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = readNonEmptyString(payload.id);
  const createdAtMs = readTimestamp(payload.createdAtMs);
  const expiresAtMs = readTimestamp(payload.expiresAtMs);
  if (!id || createdAtMs === null || expiresAtMs === null || !Array.isArray(payload.questions)) {
    return null;
  }
  if (payload.questions.length < 1 || payload.questions.length > 3) {
    return null;
  }
  const questions = payload.questions.map(parseQuestion);
  if (!questions.every((question) => question !== null)) {
    return null;
  }
  const questionIds = new Set(questions.map((question) => question.questionId));
  if (questionIds.size !== questions.length) {
    return null;
  }
  const agentId = payload.agentId === undefined ? undefined : readNonEmptyString(payload.agentId);
  const sessionKey =
    payload.sessionKey === undefined ? undefined : readNonEmptyString(payload.sessionKey);
  const runId = payload.runId === undefined ? undefined : readNonEmptyString(payload.runId);
  if (
    (payload.agentId !== undefined && !agentId) ||
    (payload.sessionKey !== undefined && !sessionKey) ||
    (payload.runId !== undefined && !runId)
  ) {
    return null;
  }
  const base = {
    id,
    questions,
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    createdAtMs,
    expiresAtMs,
  };
  if (payload.status === "pending") {
    const draftAnswers =
      payload.draftAnswers === undefined ? undefined : parseQuestionAnswers(payload.draftAnswers);
    const draftRevision =
      payload.draftRevision === undefined ? 0 : readTimestamp(payload.draftRevision);
    const draftCompletedIds =
      payload.draftCompletedIds === undefined ? [] : payload.draftCompletedIds;
    if (
      (payload.draftAnswers !== undefined && !draftAnswers) ||
      draftRevision === null ||
      !Array.isArray(draftCompletedIds) ||
      !draftCompletedIds.every(
        (candidate) => typeof candidate === "string" && questionIds.has(candidate),
      )
    ) {
      return null;
    }
    return {
      ...base,
      status: "pending",
      ...(draftAnswers ? { draftAnswers } : {}),
      draftRevision,
      draftCompletedIds,
    };
  }
  if (payload.status === "answered") {
    const answers = parseQuestionAnswers(payload.answers);
    return answers ? { ...base, status: "answered", answers } : null;
  }
  return payload.status === "cancelled" || payload.status === "expired"
    ? { ...base, status: payload.status }
    : null;
}
