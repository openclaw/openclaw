import {
  isPreparedModelRuntimePluginLifecycleFailure,
  PreparedModelRuntimeOwnerNotPublishedError,
} from "../../agents/prepared-model-runtime.errors.js";
import { AsyncWorkScopeClosedError } from "../../shared/async-work-scope.js";
import { PluginInventoryRetiredError } from "../plugin-instance-error.js";
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

/** Host reload/retirement refusals: the completion never ran and a fresh plugin operation may retry. */
export function isLlmRuntimeLifecycleFailure(error: unknown): error is Error {
  return (
    error instanceof AsyncWorkScopeClosedError ||
    error instanceof PluginInventoryRetiredError ||
    isPreparedModelRuntimePluginLifecycleFailure(error) ||
    (error instanceof PreparedModelRuntimeOwnerNotPublishedError && error.admissionBlocked)
  );
}

/** Give plugin callers a stable code for lifecycle refusals; other failures pass through. */
export function withLlmRuntimeLifecycleErrors<P, R>(
  complete: (params: P) => Promise<R>,
): (params: P) => Promise<R> {
  return (params) =>
    complete(params).catch((error: unknown) => {
      throw isLlmRuntimeLifecycleFailure(error)
        ? createLlmCompleteError("LLM_RUNTIME_LIFECYCLE", error.message, error)
        : error;
    });
}
