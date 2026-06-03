/** One quota window reported by a provider usage endpoint. */
export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type ProviderUsageSnapshot = {
  provider: UsageProviderId;
  displayName: string;
  windows: UsageWindow[];
  summary?: string;
  plan?: string;
  error?: string;
};

export type UsageSummary = {
  updatedAt: number;
  providers: ProviderUsageSnapshot[];
};

export type UsageProviderId =
  | "anthropic"
  | "deepseek"
  | "github-copilot"
  | "google-gemini-cli"
  | "minimax"
  | "openai"
  | "xiaomi"
  | "xiaomi-token-plan"
  | "zai";

/**
 * Subscription/limit windows shaped for the reply usage-state contract (the
 * `limits` field on `reply_payload_sending` `usageState`). Snake-cased to match
 * the rest of the plugin-facing contract; percentages are 0–100.
 */
export type ReplyUsageLimitWindow = {
  label: string;
  used_pct: number;
  pct_left: number;
  resets_in_s?: number;
};
export type ReplyUsageLimits = {
  available: boolean;
  source: string;
  display_name?: string;
  windows: ReplyUsageLimitWindow[];
};
