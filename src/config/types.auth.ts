export type AuthProfileRateLimit = {
  /** Max requests per minute. @default 100 for Anthropic OAuth */
  rpm?: number;
  /** Max tokens per minute. @default 40000 for Anthropic OAuth */
  tpm?: number;
  /** Max requests per hour (optional stricter limit) */
  rph?: number;
};

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
  /**
   * Provider-specific rate limits for this credential.
   * Enforced proactively to avoid hitting provider rate limits (especially
   * Anthropic OAuth which has tight TPM limits during compaction).
   */
  rateLimit?: AuthProfileRateLimit;
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
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
  };
};
