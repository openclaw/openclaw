export type AuthProfileConfig = {
  provider: string;
  /**
   * Credential type expected in auth-profiles.json for this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   */
  mode: "api_key" | "oauth" | "token";
  email?: string;
  displayName?: string;
};

/**
 * Retry counts keyed by normalized failover reason names.
 *
 * Property names intentionally use snake_case to match failover reason IDs
 * emitted by the runtime classifier (e.g. "rate_limit", "auth_failure").
 */
export type FailoverRetriesConfig = {
  /** Default retry count for rate_limit and overloaded errors. Default: 0. */
  default?: number;
  /** Retry count for rate_limit errors. Defaults to `default` (or 0 when unset). */
  rate_limit?: number;
  /** Retry count for overloaded errors. Defaults to `default` (or 0 when unset). */
  overloaded?: number;
  /** Retry count for auth failures. Default: 0 (no retry). */
  auth_failure?: number;
};

export type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
  cooldowns?: {
    /** Default billing backoff (hours). Default: 5. */
    billingBackoffHours?: number;
    /** Optional per-provider billing backoff (hours). */
    billingBackoffHoursByProvider?: Record<string, number>;
    /** Billing backoff cap (hours). Default: 24. */
    billingMaxHours?: number;
    /** Default rate-limit backoff (minutes). Default: 1. */
    rateLimitBackoffMinutes?: number;
    /** Rate-limit backoff cap (hours). Default: 1. */
    rateLimitMaxHours?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
  };
  /** Default retry settings for rate_limit and overloaded errors. */
  retries?: FailoverRetriesConfig;
};
