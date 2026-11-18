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
  constructor(
    readonly sessionId: string,
    readonly reason: "rebuilding" | "window-changed" = "rebuilding",
  ) {
    super(
      `Session transcript ${reason === "rebuilding" ? "projection is rebuilding" : "history window changed"}: ${sessionId}`,
    );
    this.name = "SessionTranscriptProjectionUnavailableError";
  }
}

export function isSessionTranscriptProjectionUnavailableError(
  error: unknown,
): error is SessionTranscriptProjectionUnavailableError {
  return error instanceof SessionTranscriptProjectionUnavailableError;
}
