import { type InlineDirectives, parseInlineSessionDirectives } from "./directive-handling.parse.js";

const EMPTY_DIRECTIVES = { ...parseInlineSessionDirectives(""), command: undefined };

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

/** Clears all inline directive state while preserving cleaned text. */
export function clearInlineDirectives(cleaned: string): InlineDirectives {
  return { ...EMPTY_DIRECTIVES, cleaned };
}

/** Clears only exec-related directive state after execution policy is consumed. */
export function clearExecInlineDirectives(directives: InlineDirectives): InlineDirectives {
  return {
    ...directives,
    ...CLEARED_EXEC_FIELDS,
  };
}
