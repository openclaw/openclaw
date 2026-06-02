import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

export type HandshakeAuthLogDecision = {
  shouldLog: boolean;
  suppressedSinceLastLog: number;
};

type HandshakeAuthLogState = {
  lastLoggedAtMs: number;
  suppressedSinceLastLog: number;
};

export class HandshakeAuthLogLimiter {
  private readonly intervalMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, HandshakeAuthLogState>();

  constructor(options?: { intervalMs?: number; maxEntries?: number }) {
    this.intervalMs = resolveIntegerOption(options?.intervalMs, 30_000, { min: 1 });
    this.maxEntries = resolveIntegerOption(options?.maxEntries, 256, { min: 1 });
  }

  register(key: string, nowMs = Date.now()): HandshakeAuthLogDecision {
    const entry = this.entries.get(key);
    if (!entry) {
      this.pruneIfNeeded();
      this.entries.set(key, {
        lastLoggedAtMs: nowMs,
        suppressedSinceLastLog: 0,
      });
      return { shouldLog: true, suppressedSinceLastLog: 0 };
    }

    if (nowMs - entry.lastLoggedAtMs < this.intervalMs) {
      // Suppression is per fingerprint so startup retries from one client do
      // not hide different clients, methods, or auth reasons.
      entry.suppressedSinceLastLog += 1;
      return { shouldLog: false, suppressedSinceLastLog: 0 };
    }

    const suppressedSinceLastLog = entry.suppressedSinceLastLog;
    entry.lastLoggedAtMs = nowMs;
    entry.suppressedSinceLastLog = 0;
    return { shouldLog: true, suppressedSinceLastLog };
  }

  private pruneIfNeeded(): void {
    if (this.entries.size < this.maxEntries) {
      return;
    }
    // Map insertion order gives a simple FIFO cap; limiter freshness is best
    // effort and only controls log volume, not authorization decisions.
    const oldestKey = this.entries.keys().next().value;
    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}

export function buildHandshakeAuthLogKey(params: {
  reason?: string;
  remoteAddr?: string;
  client?: string;
  mode?: string;
  authProvided?: string;
}): string {
  // Include enough request shape to separate benign dashboard retries from
  // security-relevant mismatches without logging raw credential material.
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
