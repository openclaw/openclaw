import type { ModelAuthStatusResult } from "../api/types.ts";

export type ProviderUsageDisplayProps = {
  basePath?: string;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
};

type QuotaLimitSummary = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

type QuotaBudgetSummary = {
  label?: string;
  used: number;
  limit: number;
  unit: string;
};

export type ProviderQuotaGroup = {
  /** Auth provider ids sharing this usage payload (e.g. anthropic + claude-cli). */
  providers: string[];
  displayName: string;
  plan?: string;
  accountEmail?: string;
  windows: QuotaLimitSummary[];
  budgets: QuotaBudgetSummary[];
};
