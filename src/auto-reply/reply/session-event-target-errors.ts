/** A captured destination was positively replaced; retrying cannot restore its custody. */
export class SessionEventTargetRetiredError extends Error {
  readonly code = "SESSION_EVENT_TARGET_RETIRED";

  constructor(message: string) {
    super(message);
    this.name = "SessionEventTargetRetiredError";
  }
}

export function isSessionEventTargetRetiredError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "SESSION_EVENT_TARGET_RETIRED";
}
