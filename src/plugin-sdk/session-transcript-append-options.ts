import type { LockedTranscriptMessageAppendOptions } from "../config/sessions/session-accessor.types.js";

/** Project the public contract so untyped callers cannot supply private worker authority. */
export function projectSessionTranscriptAppendOptions<TMessage>(
  options: LockedTranscriptMessageAppendOptions<TMessage>,
): LockedTranscriptMessageAppendOptions<TMessage> {
  return {
    appendIntent: options.appendIntent,
    beforeFreshMessageCommit: options.beforeFreshMessageCommit,
    config: options.config,
    cwd: options.cwd,
    eventId: options.eventId,
    expectedMutationAt: options.expectedMutationAt,
    expectedTranscript: options.expectedTranscript,
    idempotencyLookup: options.idempotencyLookup,
    message: options.message,
    now: options.now,
    parentId: options.parentId,
    preparation: options.preparation && {
      prepareMessage: options.preparation.prepareMessage,
      source: options.preparation.source,
    },
    prepareMessageAfterIdempotencyCheck: options.prepareMessageAfterIdempotencyCheck,
    prepareMessageAfterIdempotencyCheckAsync: options.prepareMessageAfterIdempotencyCheckAsync,
    useRawWhenLinear: options.useRawWhenLinear,
  };
}
