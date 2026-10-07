import { pruneMapToMaxSize } from "../../../infra/map-size.js";

type HandshakeAuthLogState = {
  lastLoggedAtMs: number;
  suppressedSinceLastLog: number;
};

/** Per-key log limiter that reports suppressed auth attempts on the next emitted log. */
export class HandshakeAuthLogLimiter {
  private readonly entries = new Map<string, HandshakeAuthLogState>();

  register(key: string, nowMs = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) {
      pruneMapToMaxSize(this.entries, 255);
      this.entries.set(key, {
        lastLoggedAtMs: nowMs,
        suppressedSinceLastLog: 0,
      });
      return { shouldLog: true, suppressedSinceLastLog: 0 };
    }

    if (nowMs - entry.lastLoggedAtMs < 30_000) {
      entry.suppressedSinceLastLog += 1;
      return { shouldLog: false, suppressedSinceLastLog: 0 };
    }

    const suppressedSinceLastLog = entry.suppressedSinceLastLog;
    entry.lastLoggedAtMs = nowMs;
    entry.suppressedSinceLastLog = 0;
    return { shouldLog: true, suppressedSinceLastLog };
  }
}

export function buildHandshakeAuthLogKey(params: {
  reason?: string;
  remoteAddr?: string;
  client?: string;
  mode?: string;
  authProvided?: string;
}): string {
  return [
    params.reason ?? "unknown",
    params.remoteAddr ?? "?",
    params.client ?? "?",
    params.mode ?? "?",
    params.authProvided ?? "?",
  ].join("|");
}

export function shouldLimitMissingCredentialAuthLog(params: {
  reason?: string;
  authProvided?: string;
}): boolean {
  // Only no-credential retries are startup/config churn. Credential mismatches
  // and auth rate limits are security audit events and must log per attempt.
  return (
    params.authProvided === "none" &&
    (params.reason === "token_missing" || params.reason === "password_missing")
  );
}
