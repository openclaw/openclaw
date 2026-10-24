import type {
  QuestionRecord,
  QuestionWaitAnswerResult,
} from "../../packages/gateway-protocol/src/index.js";
export function questionWaitResult(
  entry: { record: QuestionRecord; resolutionId?: string },
  includeResolutionId: boolean,
): QuestionWaitAnswerResult {
  const { record, resolutionId } = entry;
  if (record.status !== "answered") {
    return { status: record.status };
  }
  // Legacy native decoders reject extra fields. Correlation is opt-in per
  // waiter, never exposed on records/events or used as resolution authority.
  return {
    status: "answered",
    answers: record.answers ?? { answers: {} },
    ...(includeResolutionId && resolutionId ? { resolutionId } : {}),
  };
}
