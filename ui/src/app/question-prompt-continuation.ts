import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { requestQuestionGateway, type QuestionClient } from "./question-prompt-client.ts";
type ContinuationPrompt = { id: string; continuationMessage?: string };

export function attachQuestionContinuationReceipts<Prompt extends ContinuationPrompt>(
  value: unknown,
  findPrompt: (id: string) => Prompt | undefined,
  onReceiptChanged: (prompt: Prompt) => void,
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
      const message = [receipt.reason, receipt.nextAction]
        .filter((part): part is string => typeof part === "string")
        .join(" ");
      if (prompt.continuationMessage !== message) {
        prompt.continuationMessage = message;
        onReceiptChanged(prompt);
      }
    }
  }
}

export async function refreshQuestionContinuationReceipt<Prompt extends ContinuationPrompt>(
  client: QuestionClient,
  prompt: Prompt,
  isCurrent: () => boolean,
  onChange: () => void,
  onReceiptChanged: (prompt: Prompt) => void,
): Promise<void> {
  const result = await requestQuestionGateway(client, "question.list", {
    includeContinuation: true,
  });
  if (!isCurrent()) {
    return;
  }
  attachQuestionContinuationReceipts(
    result,
    (id) => (id === prompt.id ? prompt : undefined),
    onReceiptChanged,
  );
  onChange();
}
