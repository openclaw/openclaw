import type { LlmCompleteErrorCode } from "./types-core.js";

export function createLlmCompleteError(
  code: LlmCompleteErrorCode,
  message: string,
  cause?: unknown,
): Error & { code: LlmCompleteErrorCode } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    name: "LlmCompleteError",
    code,
  });
}

/** Translate only failures from the host's operator authorization checks. */
export function createLlmOperatorAuthorizationError(cause: unknown): Error {
  if (isLlmOperatorAuthorizationError(cause)) {
    return cause;
  }
  return createLlmCompleteError(
    "LLM_COMPLETION_NOT_AUTHORIZED",
    cause instanceof Error
      ? cause.message
      : "Plugin model completion operator authorization failed.",
    cause,
  );
}

export function isLlmOperatorAuthorizationError(error: unknown): error is Error {
  return (
    error instanceof Error && "code" in error && error.code === "LLM_COMPLETION_NOT_AUTHORIZED"
  );
}
