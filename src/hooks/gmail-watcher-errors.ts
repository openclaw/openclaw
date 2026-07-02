// Gmail watcher error helpers classify watcher startup and runtime failures.
const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;
const TERMINAL_OAUTH_WATCH_RE =
  /\binvalid_grant\b|refresh_token_reused|invalid refresh token|expired or revoked|sign(?:ed|ing)? in again/i;

export const GMAIL_WATCH_REAUTH_REASON =
  "gmail OAuth credentials are invalid; re-authenticate gog for the configured account";

/** Detect watcher startup failures caused by an occupied bind port. */
export function isAddressInUseError(line: string): boolean {
  return ADDRESS_IN_USE_RE.test(line);
}

function isTerminalGmailWatchAuthError(line: string): boolean {
  return TERMINAL_OAUTH_WATCH_RE.test(line);
}

export type GmailWatchStartFailure = {
  terminal: boolean;
  reason: string;
};

export type GmailWatchStartAttempt =
  | {
      ok: true;
    }
  | ({
      ok: false;
    } & GmailWatchStartFailure);

/** Classify gog watch-start failures without losing transient retry behavior. */
export function classifyGmailWatchStartFailure(message: string): GmailWatchStartFailure {
  if (isTerminalGmailWatchAuthError(message)) {
    return {
      terminal: true,
      reason: GMAIL_WATCH_REAUTH_REASON,
    };
  }
  return {
    terminal: false,
    reason: message,
  };
}
