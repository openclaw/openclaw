import { QUESTION_COMPOSER_REPLACEMENT } from "../../../../src/shared/question-composer-replacement.js";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type { ChatProjection, TurnInsertionBounds } from "./chat-thread-items.ts";
import { createTranscriptMemo } from "./components/chat-transcript-memo.ts";

const indexes = createTranscriptMemo<ReadonlyMap<string, QuestionPrompt>>();
const emptyIndex: ReadonlyMap<string, QuestionPrompt> = new Map();

export function indexQuestionPrompts(prompts: readonly QuestionPrompt[] | undefined) {
  return prompts
    ? indexes(prompts, [], () => new Map(prompts.map((prompt) => [prompt.id, prompt])))
    : emptyIndex;
}

/** Resolved summaries retain their original run; pending questions stay in the composer. */
export function projectResolvedQuestionPrompts(
  prompts: readonly QuestionPrompt[] | undefined,
  resolveBounds: (runId: string) => TurnInsertionBounds | undefined,
): ChatProjection[] {
  return (prompts ?? []).flatMap((prompt) =>
    prompt.status === "pending" ||
    prompt.resolvedBy === "plain-text" ||
    prompt.resolvedBy === QUESTION_COMPOSER_REPLACEMENT
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
