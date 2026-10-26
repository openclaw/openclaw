import type { QuestionAnswers, QuestionRecord } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatUiError } from "../lib/format-error.ts";
import { requestQuestionGateway, type QuestionClient } from "./question-prompt-client.ts";

export async function saveQuestionProgress(params: {
  client: QuestionClient;
  id: string;
  questionId: string;
  values: string[];
  revision: number;
  expiresAtMs: number;
  onRecord: (record: unknown) => void;
  onAnswer: (answers: QuestionAnswers) => void;
  onError: (error: string) => void;
}): Promise<void> {
  const { client, id, questionId, values, expiresAtMs } = params;
  const submit = (revision: number) =>
    requestQuestionGateway(
      client,
      "question.resolve",
      {
        id,
        draftAnswers: { answers: { [questionId]: values } },
        expectedRevision: revision,
        completeQuestionId: questionId,
      },
      expiresAtMs,
    );
  try {
    let result: unknown;
    try {
      result = await submit(params.revision);
    } catch (error) {
      const details =
        error instanceof Error ? (error as Error & { details?: unknown }).details : null;
      if (!isRecord(details) || details.reason !== "QUESTION_DRAFT_CONFLICT") {
        throw error;
      }
      const latest = await requestQuestionGateway(client, "question.get", { id }, expiresAtMs);
      const record = isRecord(latest) ? latest.question : null;
      if (!isRecord(record) || record.status !== "pending") {
        return;
      }
      params.onRecord(record);
      if (
        Array.isArray(record.draftCompletedIds) &&
        record.draftCompletedIds.includes(questionId)
      ) {
        return;
      }
      result = await submit(typeof record.draftRevision === "number" ? record.draftRevision : 0);
    }
    if (!isRecord(result)) {
      return;
    }
    if (result.status === "pending") {
      params.onRecord(result.question);
    } else if (result.status === "answered" && isRecord(result.answers)) {
      params.onAnswer(result.answers as QuestionAnswers);
    }
  } catch (error) {
    params.onError(formatUiError(error));
  }
}

/** Connects the network draft update to the existing chat state owner. */
export async function saveQuestionProgressForState(
  state: {
    client: QuestionClient | null;
    prompts: Map<
      string,
      {
        status: string;
        draftCompletedIds?: string[];
        draftRevision?: number;
        expiresAtMs: number;
        error: string | null;
        revision: number;
      }
    >;
    revision: number;
    onChange: () => void;
  },
  id: string,
  questionId: string,
  values: string[],
  onRecord: (record: QuestionRecord) => void,
  onAnswer: (answers: QuestionAnswers) => void,
): Promise<void> {
  const client = state.client;
  const current = state.prompts.get(id);
  if (
    !client ||
    !current ||
    current.status !== "pending" ||
    current.draftCompletedIds?.includes(questionId)
  ) {
    return;
  }
  await saveQuestionProgress({
    client,
    id,
    questionId,
    values,
    revision: current.draftRevision ?? 0,
    expiresAtMs: current.expiresAtMs,
    onRecord: (value) => onRecord(value as QuestionRecord),
    onAnswer,
    onError: (error) => {
      const pending = state.prompts.get(id);
      if (pending?.status !== "pending") {
        return;
      }
      pending.error = error;
      pending.revision = ++state.revision;
      state.onChange();
    },
  });
}
