import type { SessionBindingErrorCode, SessionBindingPlacement } from "./session-binding.types.js";

export class SessionBindingError extends Error {
  constructor(
    public readonly code: SessionBindingErrorCode,
    message: string,
    public readonly details?: {
      channel?: string;
      accountId?: string;
      placement?: SessionBindingPlacement;
    },
  ) {
    super(message);
    this.name = "SessionBindingError";
  }
}

export function isSessionBindingError(error: unknown): error is SessionBindingError {
  return error instanceof SessionBindingError;
}
