import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export const ASYNC_QUESTION_ANSWERED = "async-question-already-answered";

/** Correlation only; the input owner validates the canonical question and current authority. */
export function readAsyncQuestionAnswer(message: unknown) {
  const record = asOptionalRecord(message);
  const metadata = asOptionalRecord(record?.["__openclaw"]);
  return record?.role === "user" &&
    typeof metadata?.asyncQuestionItemId === "string" &&
    typeof metadata.replyToId === "string" &&
    typeof record.idempotencyKey === "string"
    ? {
        itemId: metadata.asyncQuestionItemId,
        sourceMessageId: metadata.replyToId,
        idempotencyKey: record.idempotencyKey,
      }
    : undefined;
}

export function assertAsyncQuestionSource(source: unknown, itemId: string): void {
  const message = asOptionalRecord(source);
  const delivery = asOptionalRecord(message?.openclawAsyncDelivery);
  if (
    message?.role !== "assistant" ||
    delivery?.itemId !== itemId ||
    !Array.isArray(delivery.questions)
  ) {
    throw new Error("Async question is not on the current conversation branch; refresh and retry.");
  }
}
