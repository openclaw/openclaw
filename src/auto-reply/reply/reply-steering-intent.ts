import type { InlineDirectives } from "./directive-handling.parse.js";

/** Host-owned scheduling intent; it grants no incumbent execution authority. */
export type ReplySteeringIntent =
  | Readonly<{ kind: "continue-existing" }>
  | Readonly<{ kind: "new-execution" }>;

/** Call after directive authorization; never infer intent from resolved defaults. */
export function resolveReplySteeringIntent(params: {
  directives: InlineDirectives;
  resetTriggered: boolean;
}): ReplySteeringIntent {
  const { directives } = params;
  return params.resetTriggered ||
    directives.hasModelDirective ||
    directives.hasExecDirective ||
    directives.hasElevatedDirective ||
    directives.hasThinkDirective ||
    directives.hasFastDirective ||
    directives.hasReasoningDirective
    ? { kind: "new-execution" }
    : { kind: "continue-existing" };
}
