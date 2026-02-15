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
};

export type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
  cooldowns?: {
    /** Default billing backoff duration (e.g. "5h", "30m"). Default: "5h". */
    billingBackoff?: string;
    /** Optional per-provider billing backoff durations (e.g. { myProvider: "5m" }). */
    billingBackoffByProvider?: Record<string, string>;
    /** Billing backoff cap duration (e.g. "24h"). Default: "24h". */
    billingMax?: string;
    /**
     * Failure window for backoff counters (e.g. "24h"). If no failures occur
     * within this window, counters reset. Default: "24h".
     */
    failureWindow?: string;
    /**
     * How to handle billing/402 errors.
     * - "disable": (default) Disable the profile for hours (exponential backoff).
     *   Best for provider API keys where credits require manual action.
     * - "retry": Short 5-minute cooldown then retry. Best for prepaid credit
     *   systems where top-ups are fast and automated.
     * - "notify": No cooldown — just show the error and continue. The profile
     *   stays available for immediate retry after the user tops up.
     */
    billingRecoveryMode?: "disable" | "retry" | "notify";
  };
};
