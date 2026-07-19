/** Raised when a reset command's authorized session identity changed before mutation. */
export class ReplySessionResetTargetChangedError extends Error {
  constructor() {
    super("authorized reset target changed before session mutation");
    this.name = "ReplySessionResetTargetChangedError";
  }
}

export const REPLY_SESSION_RESET_TARGET_CHANGED_REPLY =
  "Session reset was not applied because the session changed. Retry.";
