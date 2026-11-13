import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { ChatProjection, TurnInsertionBounds } from "./chat-thread-items.ts";
import { createTranscriptMemo } from "./components/chat-transcript-memo.ts";

/** Only the requesting operation identifies a blocking question in this conversation. */
export function isInlineBlockingQuestion(prompt: QuestionPrompt, sessionKey: string): boolean {
  return prompt.blocking === true && areUiSessionKeysEquivalent(prompt.sessionKey, sessionKey);
}

/** Keep pending blocking requests and resolved summaries in their original run. */
export function projectQuestionPrompts(
  input: { questionPrompts?: readonly QuestionPrompt[]; sessionKey: string },
  resolveBounds: (runId: string) => TurnInsertionBounds | undefined,
): ChatProjection[] {
  return (input.questionPrompts ?? []).flatMap((prompt) =>
    prompt.status === "pending" && !isInlineBlockingQuestion(prompt, input.sessionKey)
      ? []
      : [
          {
            item: {
              kind: "question",
              key: `question:${prompt.id}`,
              questionId: prompt.id,
              startedAt: prompt.createdAtMs,
            },
            bounds: prompt.runId ? resolveBounds(prompt.runId) : undefined,
          },
        ],
  );
}

const indexes = createTranscriptMemo<ReadonlyMap<string, QuestionPrompt>>();
const emptyIndex: ReadonlyMap<string, QuestionPrompt> = new Map();

export function indexQuestionPrompts(prompts: readonly QuestionPrompt[] | undefined) {
  return prompts
    ? indexes(prompts, [], () => new Map(prompts.map((prompt) => [prompt.id, prompt])))
    : emptyIndex;
}
