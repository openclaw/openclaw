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
     * Base backoff for permanent-auth failures (minutes). These errors (e.g.
     * API_KEY_INVALID) can be caused by transient provider outages, so the
     * default is much shorter than billing backoff. Default: 10.
     */
    authPermanentBackoffMinutes?: number;
    /**
     * Cap for permanent-auth backoff (minutes). Default: 60.
     */
    authPermanentMaxMinutes?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for overloaded
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    overloadedProfileRotations?: number;
    /**
     * Fixed delay before retrying an overloaded provider/profile rotation.
     * Default: 0.
     */
    overloadedBackoffMs?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for rate-limit
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    rateLimitedProfileRotations?: number;
  };
};
