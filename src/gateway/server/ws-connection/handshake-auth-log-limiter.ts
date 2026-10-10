import { pruneMapToMaxSize } from "../../../infra/map-size.js";

type HandshakeAuthLogState = {
  lastLoggedAtMs: number;
  suppressedSinceLastLog: number;
};

/** Per-key log limiter that reports suppressed auth attempts on the next emitted log. */
export class HandshakeAuthLogLimiter {
  private readonly entries = new Map<string, HandshakeAuthLogState>();

  missingCredentialLogSuffix(
    params: {
      reason?: string;
      remoteAddr?: string;
      client?: string;
      mode?: string;
      authProvided?: string;
    },
    nowMs?: number,
  ): string | undefined {
    // Credential mismatches and auth rate limits must log every attempt.
    if (
      params.authProvided !== "none" ||
      (params.reason !== "token_missing" && params.reason !== "password_missing")
    ) {
      return "";
    }
    const key = [
      params.reason,
      params.remoteAddr ?? "?",
      params.client ?? "?",
      params.mode ?? "?",
      params.authProvided,
    ].join("|");
    const now = nowMs ?? Date.now();
    const entry = this.entries.get(key);
    if (!entry) {
      pruneMapToMaxSize(this.entries, 255);
      this.entries.set(key, {
        lastLoggedAtMs: now,
        suppressedSinceLastLog: 0,
      });
      return "";
    }

    if (now - entry.lastLoggedAtMs < 30_000) {
      entry.suppressedSinceLastLog += 1;
      return undefined;
    }

    const suppressedSinceLastLog = entry.suppressedSinceLastLog;
    entry.lastLoggedAtMs = now;
    entry.suppressedSinceLastLog = 0;
    return suppressedSinceLastLog > 0 ? ` suppressed=${suppressedSinceLastLog}` : "";
  }
}
