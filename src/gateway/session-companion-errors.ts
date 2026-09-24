type SessionCompanionAskErrorReason =
  | "busy"
  | "context-unavailable"
  | "rate-limited"
  | "session-missing"
  | "utility-model-unavailable"
  | "unavailable";

export class SessionCompanionAskError extends Error {
  constructor(
    readonly reason: SessionCompanionAskErrorReason,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SessionCompanionAskError";
  }
}
