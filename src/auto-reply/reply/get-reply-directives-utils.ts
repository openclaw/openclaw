import { isFailoverError } from "../../agents/failover/error.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { ModelSelectionLockedError } from "../../sessions/model-overrides.js";
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

export function resolveModelSelectionErrorReply(error: unknown) {
  const unsupportedChat = isFailoverError(error) && error.code === "model_chat_unsupported";
  if (
    !(error instanceof ModelSelectionLockedError) &&
    !isSessionWorkStartInvalidatedError(error) &&
    !unsupportedChat
  ) {
    throw error;
  }
  return {
    reply: { text: error.message, isError: true },
    preRunRejection:
      error instanceof ModelSelectionLockedError
        ? ("model-selection-locked" as const)
        : unsupportedChat
          ? ("model-selection-rejected" as const)
          : undefined,
  };
}
