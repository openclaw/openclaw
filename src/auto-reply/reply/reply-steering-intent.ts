import type { SourceQuestionInputV1 } from "../source-question.types.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

/** Host-owned scheduling intent; it grants no incumbent execution authority. */
export type ReplySteeringIntent =
  | Readonly<{ kind: "continue-existing" }>
  | Readonly<{ kind: "new-execution" }>;

/** Call after directive authorization; never infer intent from resolved defaults. */
export function resolveReplySteeringIntent(params: {
  directives: InlineDirectives;
  resetTriggered: boolean;
  sourceQuestionInput?: SourceQuestionInputV1;
}): ReplySteeringIntent {
  const { directives } = params;
  return params.sourceQuestionInput?.mode === "new-task" ||
    params.resetTriggered ||
    directives.hasModelDirective ||
    directives.hasExecDirective ||
    directives.hasElevatedDirective ||
    directives.hasThinkDirective ||
    directives.hasFastDirective ||
    directives.hasReasoningDirective
    ? { kind: "new-execution" }
    : { kind: "continue-existing" };
}
