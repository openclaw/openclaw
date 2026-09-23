import type { OpenClawAgentDatabaseReadOnlyResult } from "../../state/openclaw-agent-db-readonly-open.js";

export class SessionTranscriptStorageUnavailableError extends Error {
  constructor(
    readonly reason?: Extract<
      OpenClawAgentDatabaseReadOnlyResult<never>,
      { found: false }
    >["reason"],
  ) {
    super("Session transcript storage is unavailable; open the source gateway and retry.");
    this.name = "SessionTranscriptStorageUnavailableError";
  }
}

export class SessionTranscriptProjectionUnavailableError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session transcript projection is rebuilding: ${sessionId}`);
    this.name = "SessionTranscriptProjectionUnavailableError";
  }
}

export function isSessionTranscriptProjectionUnavailableError(
  error: unknown,
): error is SessionTranscriptProjectionUnavailableError {
  return error instanceof SessionTranscriptProjectionUnavailableError;
}
