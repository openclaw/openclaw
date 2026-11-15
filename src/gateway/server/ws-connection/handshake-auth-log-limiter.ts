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
    return this.logSuffix(key, nowMs);
  }

  nativeAuthUnavailableLogSuffix(
    params: {
      code: number;
      reason: string;
      remoteAddr?: string;
      origin?: string;
      userAgent?: string;
    },
    nowMs?: number,
  ): string | undefined {
    if (params.code !== 4008 || params.reason !== "native authorization unavailable") {
      return "";
    }
    // Peer-reported diagnostics are not native identity or authorization evidence.
    // Reconnects change connection ids and source ports, not this bounded group.
    const key = JSON.stringify([
      "native-auth-unavailable",
      params.remoteAddr ?? "?",
      params.origin ?? "?",
      params.userAgent ?? "?",
    ]);
    return this.logSuffix(key, nowMs);
  }

  private logSuffix(key: string, nowMs?: number): string | undefined {
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
