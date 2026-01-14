import type { InlineDirectives } from "./directive-handling.js";

export function clearInlineDirectives(cleaned: string): InlineDirectives {
  return {
    cleaned,
    hasThinkDirective: false,
    thinkLevel: undefined,
    rawThinkLevel: undefined,
    hasVerboseDirective: false,
    verboseLevel: undefined,
    rawVerboseLevel: undefined,
    hasReasoningDirective: false,
    reasoningLevel: undefined,
    rawReasoningLevel: undefined,
    hasElevatedDirective: false,
    elevatedLevel: undefined,
    rawElevatedLevel: undefined,
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
