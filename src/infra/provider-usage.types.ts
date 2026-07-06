/** One quota window reported by a provider usage endpoint. */
export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

/** Provider-reported monetary or credit facts. Units may be ISO currencies or provider credits. */
export type ProviderUsageBilling =
  | {
      type: "balance";
      label?: string;
      amount: number;
      unit: string;
    }
  | {
      type: "spend";
      label?: string;
      amount: number;
      unit: string;
      period?: string;
      resetAt?: number;
    }
  | {
      type: "budget";
      label?: string;
      used: number;
      limit: number;
      unit: string;
      period?: string;
      resetAt?: number;
    };

export type ProviderUsageSnapshot = {
  provider: UsageProviderId;
  displayName: string;
  windows: UsageWindow[];
  billing?: ProviderUsageBilling[];
  summary?: string;
  plan?: string;
  error?: string;
};

export type UsageSummary = {
  updatedAt: number;
  providers: ProviderUsageSnapshot[];
};

/** Normalized provider id. Usage providers are discovered from plugin hooks at runtime. */
export type UsageProviderId = string;
