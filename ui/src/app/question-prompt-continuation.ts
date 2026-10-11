import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { requestQuestionGateway, type QuestionClient } from "./question-prompt-client.ts";
type ContinuationPrompt = { id: string; continuationMessage?: string };

export function attachQuestionContinuationReceipts(
  value: unknown,
  findPrompt: (id: string) => ContinuationPrompt | undefined,
): void {
  if (!isRecord(value) || !Array.isArray(value.continuations)) {
    return;
  }
  for (const receipt of value.continuations) {
    if (
      !isRecord(receipt) ||
      typeof receipt.questionId !== "string" ||
      (receipt.status !== "blocked" && receipt.status !== "interrupted")
    ) {
      continue;
    }
    const prompt = findPrompt(receipt.questionId);
    if (prompt) {
      prompt.continuationMessage = [receipt.reason, receipt.nextAction]
        .filter((part): part is string => typeof part === "string")
        .join(" ");
    }
  }
}

export async function refreshQuestionContinuationReceipt(
  client: QuestionClient,
  prompt: ContinuationPrompt,
  isCurrent: () => boolean,
  onChange: () => void,
): Promise<void> {
  const result = await requestQuestionGateway(client, "question.list", {
    includeContinuation: true,
  });
  if (!isCurrent()) {
    return;
  }
  attachQuestionContinuationReceipts(result, (id) => (id === prompt.id ? prompt : undefined));
  onChange();
}
