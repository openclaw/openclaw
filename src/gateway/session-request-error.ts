import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntryCreateWithTranscriptResult } from "../config/sessions/session-accessor.types.js";

export function sessionCreationFailure(
  failure: Extract<SessionEntryCreateWithTranscriptResult<ErrorShape>, { ok: false }>,
): { ok: false; error: ErrorShape } {
  return {
    ok: false,
    error:
      failure.phase === "transcript"
        ? errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to create session transcript: ${failure.error}`,
          )
        : failure.error,
  };
}

export function invalidSessionRequest(
  message: string,
  options?: Parameters<typeof errorShape>[2],
): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message, options) };
}

/** A caller-selected directory is named so the caller can correct it; the default workspace is not. */
export function nonGitWorktreeSourceMessage(
  requestedWorkspace?: string | { kind: "empty" },
): string {
  return typeof requestedWorkspace === "string"
    ? `requested working directory is not a git checkout: ${requestedWorkspace}`
    : "agent workspace is not a git checkout";
}

export function unavailableSessionRequest(message: string): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, message) };
}
