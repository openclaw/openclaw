import type { InlineDirectives } from "./directive-handling.js";

const CLEARED_EXEC_FIELDS = {
  hasExecDirective: false,
  execHost: undefined,
  execSecurity: undefined,
  execAsk: undefined,
  execNode: undefined,
  rawExecHost: undefined,
  rawExecSecurity: undefined,
  rawExecAsk: undefined,
  rawExecNode: undefined,
  hasExecOptions: false,
  invalidExecHost: false,
  invalidExecSecurity: false,
  invalidExecAsk: false,
  invalidExecNode: false,
} satisfies Partial<InlineDirectives>;

export function clearInlineDirectives(cleaned: string): InlineDirectives {
  return {
    cleaned,
    hasThinkDirective: false,
    thinkLevel: undefined,
    rawThinkLevel: undefined,
    oneShotThinkLevel: undefined,
    hasVerboseDirective: false,
    verboseLevel: undefined,
    rawVerboseLevel: undefined,
    hasFastDirective: false,
    fastMode: undefined,
    rawFastMode: undefined,
    hasReasoningDirective: false,
    reasoningLevel: undefined,
    rawReasoningLevel: undefined,
    hasElevatedDirective: false,
    elevatedLevel: undefined,
    rawElevatedLevel: undefined,
    ...CLEARED_EXEC_FIELDS,
    hasStatusDirective: false,
    hasModelDirective: false,
    rawModelDirective: undefined,
    hasQueueDirective: false,
    queueMode: undefined,
    queueReset: false,
    rawQueueMode: undefined,
    debounceMs: undefined,
    cap: undefined,
    dropPolicy: undefined,
    rawDebounce: undefined,
    rawCap: undefined,
    rawDrop: undefined,
    hasQueueOptions: false,
  };
}

export function normalizeInlineDirectivesForMessage(params: {
  directives: InlineDirectives;
  allowInlineStatus: boolean;
  oneShotThinkLevel?: InlineDirectives["oneShotThinkLevel"];
}): InlineDirectives {
  // Clear ALL directives for mixed directive+body messages, matching existing behavior.
  // Only oneShotThinkLevel is attached; other directives (verbose, model, queue, etc.)
  // are not preserved to avoid accidental session pollution.
  const cleared = clearInlineDirectives(params.directives.cleaned);
  if (params.oneShotThinkLevel !== undefined) {
    return { ...cleared, oneShotThinkLevel: params.oneShotThinkLevel };
  }
  return params.allowInlineStatus ? { ...cleared, hasStatusDirective: true } : cleared;
}

export function clearExecInlineDirectives(directives: InlineDirectives): InlineDirectives {
  return {
    ...directives,
    ...CLEARED_EXEC_FIELDS,
  };
}
