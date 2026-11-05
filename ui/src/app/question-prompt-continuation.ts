import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { QuestionClient } from "./question-prompt-client.ts";
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

export function attachCurrentQuestionContinuationReceipt<
  Prompt extends ContinuationPrompt & { revision: number },
>(
  result: unknown,
  state: {
    client: QuestionClient | null;
    clientGeneration: number;
    prompts: Map<string, Prompt>;
    revision: number;
    onChange: () => void;
  },
  client: QuestionClient,
  prompt: Prompt,
  generation: number,
  revision: number,
): void {
  if (
    state.client !== client ||
    state.clientGeneration !== generation ||
    state.prompts.get(prompt.id) !== prompt ||
    prompt.revision !== revision
  ) {
    return;
  }
  attachQuestionContinuationReceipts(
    result,
    (id) => (id === prompt.id ? prompt : undefined),
    (changed) => {
      changed.revision = ++state.revision;
    },
  );
  state.onChange();
}
