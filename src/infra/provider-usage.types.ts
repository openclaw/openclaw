export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type ProviderUsageSnapshot = {
  provider: UsageProviderId;
  displayName: string;
  windows: UsageWindow[];
  plan?: string;
  /** Credit-balance string (e.g. "$5.00"). When set, the snapshot carries
   *  usage data even if windows is empty; format functions use this to
   *  suppress the "no data" marker and include the provider in summaries. */
  balance?: string;
  error?: string;
};

export type UsageSummary = {
  updatedAt: number;
  providers: ProviderUsageSnapshot[];
};

export type UsageProviderId =
  | "anthropic"
  | "github-copilot"
  | "google-gemini-cli"
  | "minimax"
  | "openai-codex"
  | "xiaomi"
  | "zai";
